#if defined(__linux__)
#define _GNU_SOURCE
#endif

/*
 * Threadleaf's app-private state lock.
 *
 * This is a deliberately small Node-API boundary. The lock authority is the
 * kernel-held descriptor/handle, not bytes written to the lock path. The path
 * is one persistent regular file and is never removed or replaced by this
 * module.
 */

#include "include/threadleaf_node_api.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <wchar.h>

#pragma comment(lib, "advapi32.lib")

typedef struct {
  DWORD volume_serial;
  DWORD file_index_high;
  DWORD file_index_low;
} threadleaf_identity;

typedef struct {
  HANDLE handle;
  OVERLAPPED overlapped;
  wchar_t* wide_path;
  char* utf8_path;
  threadleaf_identity identity;
  int closed;
} threadleaf_lock;

#else

#include <fcntl.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#endif

typedef struct {
  dev_t device;
  ino_t inode;
} threadleaf_identity;

typedef struct {
  int fd;
  char* utf8_path;
  threadleaf_identity identity;
  int closed;
} threadleaf_lock;

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_NOFOLLOW
#error "Threadleaf state-lock POSIX builds require O_NOFOLLOW."
#endif

#endif

static napi_value threadleaf_error(
    napi_env env,
    const char* code,
    const char* name,
    const char* message) {
  napi_value message_value;
  napi_value error;
  if (napi_create_string_utf8(env, message, (size_t)-1, &message_value) != napi_ok ||
      napi_create_error(env, NULL, message_value, &error) != napi_ok) {
    return NULL;
  }
  napi_value code_value;
  napi_value name_value;
  if (napi_create_string_utf8(env, code, (size_t)-1, &code_value) == napi_ok) {
    napi_set_named_property(env, error, "code", code_value);
  }
  if (napi_create_string_utf8(env, name, (size_t)-1, &name_value) == napi_ok) {
    napi_set_named_property(env, error, "name", name_value);
  }
  napi_throw(env, error);
  return NULL;
}

static napi_value threadleaf_invalid(napi_env env, const char* message) {
  return threadleaf_error(env, "invalid", "StateLockInvalidError", message);
}

static napi_value threadleaf_busy(napi_env env) {
  return threadleaf_error(
      env,
      "busy",
      "StateLockBusyError",
      "Another process holds the Threadleaf state lock.");
}

static napi_value threadleaf_migration_required(napi_env env) {
  return threadleaf_error(
      env,
      "migration-required",
      "StateLockMigrationRequiredError",
      "The state-lock path is an existing directory; quiesce legacy writers and migrate explicitly.");
}

static napi_value threadleaf_compromised(napi_env env) {
  return threadleaf_error(
      env,
      "compromised",
      "StateLockCompromisedError",
      "The persistent state-lock path no longer names the file opened for this transaction.");
}

static napi_value threadleaf_closed(napi_env env) {
  return threadleaf_error(
      env,
      "closed",
      "StateLockClosedError",
      "The Threadleaf state lock has already been closed.");
}

static napi_value threadleaf_io(napi_env env, const char* message) {
  return threadleaf_error(env, "io", "StateLockIoError", message);
}

static napi_value threadleaf_filesystem_error(
    napi_env env,
    const char* code,
    const char* message) {
  return threadleaf_error(env, code, "NativeFilesystemError", message);
}

#if defined(_WIN32)

static void threadleaf_wide_free(wchar_t* value) {
  free(value);
}

static wchar_t* threadleaf_utf8_to_wide(const char* value) {
  int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
  if (required <= 0) {
    return NULL;
  }
  wchar_t* converted = (wchar_t*)calloc((size_t)required, sizeof(wchar_t));
  if (!converted) {
    return NULL;
  }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, converted, required) <= 0) {
    threadleaf_wide_free(converted);
    return NULL;
  }
  return converted;
}

static int threadleaf_identity_equal(
    const threadleaf_identity* left,
    const threadleaf_identity* right) {
  return left->volume_serial == right->volume_serial &&
         left->file_index_high == right->file_index_high &&
         left->file_index_low == right->file_index_low;
}

static int threadleaf_is_windows_separator(wchar_t value) {
  return value == L'\\' || value == L'/';
}

static int threadleaf_validate_windows_path(
    const wchar_t* path,
    int* is_directory,
    int* is_reparse,
    int* exists) {
  size_t length = wcslen(path);
  size_t root_length = 0;
  if (length >= 3 && path[1] == L':' && threadleaf_is_windows_separator(path[2])) {
    root_length = 3;
  } else if (length >= 5 && path[0] == L'\\' && path[1] == L'\\') {
    size_t server_separator = 2;
    while (server_separator < length && !threadleaf_is_windows_separator(path[server_separator])) {
      server_separator += 1;
    }
    if (server_separator >= length) {
      return 0;
    }
    size_t share_separator = server_separator + 1;
    while (share_separator < length && !threadleaf_is_windows_separator(path[share_separator])) {
      share_separator += 1;
    }
    if (share_separator >= length) {
      return 0;
    }
    root_length = share_separator + 1;
  } else {
    return 0;
  }

  *exists = 0;
  *is_directory = 0;
  *is_reparse = 0;
  for (size_t end = root_length; end <= length;) {
    if (end < length && threadleaf_is_windows_separator(path[end])) {
      end += 1;
      continue;
    }
    size_t prefix_length = end;
    while (prefix_length < length && !threadleaf_is_windows_separator(path[prefix_length])) {
      prefix_length += 1;
    }
    int final_component = prefix_length == length;
    if (prefix_length == 0) {
      return 0;
    }
    wchar_t* prefix = (wchar_t*)calloc(prefix_length + 1, sizeof(wchar_t));
    if (!prefix) {
      return 0;
    }
    memcpy(prefix, path, prefix_length * sizeof(wchar_t));
    prefix[prefix_length] = L'\0';
    HANDLE prefix_handle = CreateFileW(
        prefix,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
        NULL);
    DWORD error = prefix_handle == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    free(prefix);
    if (prefix_handle == INVALID_HANDLE_VALUE) {
      if (final_component && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
        return 1;
      }
      return 0;
    }
    BY_HANDLE_FILE_INFORMATION info;
    int valid = GetFileInformationByHandle(prefix_handle, &info) != 0;
    int component_reparse =
        valid && (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    int component_directory = valid && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    CloseHandle(prefix_handle);
    if (!valid || component_reparse) {
      *is_reparse = component_reparse;
      return component_reparse ? 1 : 0;
    }
    if (!final_component && !component_directory) {
      return 0;
    }
    if (final_component) {
      *is_directory = component_directory;
      *is_reparse = 0;
      *exists = 1;
      return 1;
    }
    end = prefix_length;
  }
  return 1;
}

static int threadleaf_apply_windows_private_dacl(const wchar_t* path) {
  const wchar_t* sddl = L"D:P(A;;GA;;;OW)";
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD descriptor_length = 0;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl, SDDL_REVISION_1, &descriptor, &descriptor_length)) {
    return 0;
  }
  PACL dacl = NULL;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  BOOL read_dacl = GetSecurityDescriptorDacl(
      descriptor, &dacl_present, &dacl, &dacl_defaulted);
  DWORD result = read_dacl && dacl_present
                     ? SetNamedSecurityInfoW(
                           (LPWSTR)path,
                           SE_FILE_OBJECT,
                           DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                           NULL,
                           NULL,
                           dacl,
                           NULL)
                     : ERROR_INVALID_SECURITY_DESCR;
  LocalFree(descriptor);
  return result == ERROR_SUCCESS;
}

static threadleaf_lock* threadleaf_native_acquire_windows(
    napi_env env,
    const char* utf8_path) {
  wchar_t* wide_path = threadleaf_utf8_to_wide(utf8_path);
  if (!wide_path) {
    threadleaf_invalid(env, "The state-lock path must be valid UTF-8.");
    return NULL;
  }

  int is_directory = 0;
  int is_reparse = 0;
  int exists = 0;
  if (!threadleaf_validate_windows_path(
          wide_path, &is_directory, &is_reparse, &exists)) {
    threadleaf_wide_free(wide_path);
    threadleaf_io(env, "Could not inspect the state-lock path.");
    return NULL;
  }
  if (is_directory) {
    threadleaf_wide_free(wide_path);
    threadleaf_migration_required(env);
    return NULL;
  }
  if (is_reparse) {
    threadleaf_wide_free(wide_path);
    threadleaf_compromised(env);
    return NULL;
  }

  PSECURITY_DESCRIPTOR security_descriptor = NULL;
  DWORD security_descriptor_length = 0;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          L"D:P(A;;GA;;;OW)",
          SDDL_REVISION_1,
          &security_descriptor,
          &security_descriptor_length)) {
    threadleaf_wide_free(wide_path);
    threadleaf_io(env, "Could not create the private Windows state-lock security descriptor.");
    return NULL;
  }
  SECURITY_ATTRIBUTES security_attributes;
  memset(&security_attributes, 0, sizeof(security_attributes));
  security_attributes.nLength = sizeof(security_attributes);
  security_attributes.lpSecurityDescriptor = security_descriptor;
  security_attributes.bInheritHandle = FALSE;

  DWORD creation = exists ? OPEN_EXISTING : OPEN_ALWAYS;
  HANDLE handle = CreateFileW(
      wide_path,
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      &security_attributes,
      creation,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
      NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    LocalFree(security_descriptor);
    threadleaf_wide_free(wide_path);
    if (error == ERROR_ACCESS_DENIED && exists) {
      threadleaf_compromised(env);
    } else {
      threadleaf_io(env, "Could not open the persistent state-lock file.");
    }
    return NULL;
  }

  if (GetFileType(handle) != FILE_TYPE_DISK) {
    CloseHandle(handle);
    LocalFree(security_descriptor);
    threadleaf_wide_free(wide_path);
    threadleaf_invalid(env, "The state-lock path must name a regular file.");
    return NULL;
  }

  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info)) {
    CloseHandle(handle);
    LocalFree(security_descriptor);
    threadleaf_wide_free(wide_path);
    threadleaf_io(env, "Could not inspect the persistent state-lock file.");
    return NULL;
  }
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(handle);
    LocalFree(security_descriptor);
    threadleaf_wide_free(wide_path);
    threadleaf_compromised(env);
    return NULL;
  }

  LocalFree(security_descriptor);
  if (!threadleaf_apply_windows_private_dacl(wide_path)) {
    CloseHandle(handle);
    threadleaf_wide_free(wide_path);
    threadleaf_io(env, "Could not apply the private Windows state-lock security descriptor.");
    return NULL;
  }

  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof(overlapped));
  if (!LockFileEx(
          handle,
          LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
          0,
          1,
          0,
          &overlapped)) {
    DWORD error = GetLastError();
    CloseHandle(handle);
    threadleaf_wide_free(wide_path);
    if (error == ERROR_LOCK_VIOLATION || error == ERROR_IO_PENDING) {
      threadleaf_busy(env);
    } else {
      threadleaf_io(env, "Could not acquire the Windows state-lock byte range.");
    }
    return NULL;
  }

  threadleaf_lock* lock = (threadleaf_lock*)calloc(1, sizeof(threadleaf_lock));
  if (!lock) {
    UnlockFileEx(handle, 0, 1, 0, &overlapped);
    CloseHandle(handle);
    threadleaf_wide_free(wide_path);
    threadleaf_io(env, "Could not allocate state-lock bookkeeping.");
    return NULL;
  }
  lock->handle = handle;
  lock->overlapped = overlapped;
  lock->wide_path = wide_path;
  lock->utf8_path = _strdup(utf8_path);
  lock->identity.volume_serial = info.dwVolumeSerialNumber;
  lock->identity.file_index_high = info.nFileIndexHigh;
  lock->identity.file_index_low = info.nFileIndexLow;
  if (!lock->utf8_path) {
    UnlockFileEx(handle, 0, 1, 0, &overlapped);
    CloseHandle(handle);
    threadleaf_wide_free(wide_path);
    free(lock);
    threadleaf_io(env, "Could not allocate state-lock path bookkeeping.");
    return NULL;
  }
  return lock;
}

static int threadleaf_verify_windows(threadleaf_lock* lock) {
  if (lock->closed) {
    return -2;
  }
  int path_is_directory = 0;
  int path_is_reparse = 0;
  int path_exists = 0;
  if (!threadleaf_validate_windows_path(
          lock->wide_path,
          &path_is_directory,
          &path_is_reparse,
          &path_exists) ||
      !path_exists || path_is_directory || path_is_reparse) {
    return 0;
  }
  HANDLE path_handle = CreateFileW(
      lock->wide_path,
      0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      NULL);
  if (path_handle == INVALID_HANDLE_VALUE) {
    return 0;
  }
  BY_HANDLE_FILE_INFORMATION info;
  int valid = GetFileInformationByHandle(path_handle, &info) &&
              (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 &&
              (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
  if (valid) {
    threadleaf_identity current;
    current.volume_serial = info.dwVolumeSerialNumber;
    current.file_index_high = info.nFileIndexHigh;
    current.file_index_low = info.nFileIndexLow;
    valid = threadleaf_identity_equal(&lock->identity, &current);
  }
  CloseHandle(path_handle);
  return valid ? 1 : 0;
}

static int threadleaf_close_windows(threadleaf_lock* lock) {
  if (lock->closed) {
    return 1;
  }
  int unlocked = UnlockFileEx(lock->handle, 0, 1, 0, &lock->overlapped) != 0;
  DWORD unlock_error = unlocked ? ERROR_SUCCESS : GetLastError();
  int closed = CloseHandle(lock->handle) != 0;
  lock->handle = INVALID_HANDLE_VALUE;
  lock->closed = 1;
  if (!unlocked || !closed) {
    (void)unlock_error;
    return 0;
  }
  return 1;
}

static void threadleaf_free_windows(threadleaf_lock* lock) {
  if (!lock) {
    return;
  }
  threadleaf_close_windows(lock);
  threadleaf_wide_free(lock->wide_path);
  free(lock->utf8_path);
  free(lock);
}

#else

static int threadleaf_identity_from_stat(const struct stat* info, threadleaf_identity* identity) {
  if (!S_ISREG(info->st_mode)) {
    return 0;
  }
  identity->device = info->st_dev;
  identity->inode = info->st_ino;
  return 1;
}

static int threadleaf_identity_equal(
    const threadleaf_identity* left,
    const threadleaf_identity* right) {
  return left->device == right->device && left->inode == right->inode;
}

static int threadleaf_posix_component_is_dot(const char* component, size_t length) {
  return (length == 1 && component[0] == '.') ||
         (length == 2 && component[0] == '.' && component[1] == '.');
}

static int threadleaf_validate_posix_path(
    const char* utf8_path,
    int create_final,
    int* final_missing,
    int* final_directory,
    int* final_symlink,
    struct stat* final_info) {
  if (!utf8_path || utf8_path[0] != '/') {
    return -1;
  }
  size_t length = strlen(utf8_path);
  if (length < 2 || utf8_path[length - 1] == '/') {
    return -1;
  }

  int directory_fd = open("/", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (directory_fd < 0) {
    return -1;
  }
  *final_missing = 0;
  *final_directory = 0;
  *final_symlink = 0;
  size_t cursor = 1;
  while (cursor < length) {
    while (cursor < length && utf8_path[cursor] == '/') {
      cursor += 1;
    }
    if (cursor >= length) {
      break;
    }
    size_t component_start = cursor;
    while (cursor < length && utf8_path[cursor] != '/') {
      cursor += 1;
    }
    size_t component_length = cursor - component_start;
    if (threadleaf_posix_component_is_dot(utf8_path + component_start, component_length)) {
      close(directory_fd);
      return -1;
    }
    int final_component = cursor == length;
    char* component = (char*)calloc(component_length + 1, sizeof(char));
    if (!component) {
      close(directory_fd);
      return -1;
    }
    memcpy(component, utf8_path + component_start, component_length);
    component[component_length] = '\0';
    int flags = final_component
                    ? (O_RDWR | O_CLOEXEC | O_NOFOLLOW | (create_final ? O_CREAT : 0))
                    : (O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    int next_fd = openat(directory_fd, component, flags, 0600);
    int open_error = next_fd < 0 ? errno : 0;
    if (next_fd < 0 && final_component && create_final && open_error == EISDIR) {
      int directory_probe = openat(directory_fd, component, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      if (directory_probe >= 0) {
        struct stat directory_info;
        if (fstat(directory_probe, &directory_info) == 0 && S_ISDIR(directory_info.st_mode)) {
          *final_directory = 1;
        }
        close(directory_probe);
      }
    }
    free(component);
    if (next_fd < 0) {
      close(directory_fd);
      if (final_component && !create_final && open_error == ENOENT) {
        *final_missing = 1;
        return 0;
      }
      if (open_error == ELOOP) {
        *final_symlink = 1;
        return -2;
      }
      return -1;
    }
    struct stat opened_info;
    if (fstat(next_fd, &opened_info) != 0) {
      close(next_fd);
      close(directory_fd);
      return -1;
    }
    if (final_component) {
      close(directory_fd);
      if (S_ISLNK(opened_info.st_mode)) {
        close(next_fd);
        *final_symlink = 1;
        return -2;
      }
      if (S_ISDIR(opened_info.st_mode)) {
        *final_directory = 1;
      } else if (!S_ISREG(opened_info.st_mode)) {
        close(next_fd);
        return -1;
      }
      if (final_info) {
        *final_info = opened_info;
      }
      if (create_final && fchmod(next_fd, 0600) != 0) {
        close(next_fd);
        return -1;
      }
      return next_fd;
    }
    if (!S_ISDIR(opened_info.st_mode)) {
      close(next_fd);
      close(directory_fd);
      return -1;
    }
    close(directory_fd);
    directory_fd = next_fd;
  }
  close(directory_fd);
  return -1;
}

static threadleaf_lock* threadleaf_native_acquire_posix(
    napi_env env,
    const char* utf8_path) {
  int final_missing = 0;
  int final_directory = 0;
  int final_symlink = 0;
  struct stat opened_info;
  int fd = threadleaf_validate_posix_path(
      utf8_path,
      1,
      &final_missing,
      &final_directory,
      &final_symlink,
      &opened_info);
  if (fd < 0) {
    if (final_directory) {
      threadleaf_migration_required(env);
    } else if (final_symlink) {
      threadleaf_compromised(env);
    } else {
      threadleaf_io(env, "Could not open the persistent state-lock file or one of its ancestors.");
    }
    return NULL;
  }
  threadleaf_identity identity;
  if (!threadleaf_identity_from_stat(&opened_info, &identity)) {
    close(fd);
    threadleaf_invalid(env, "The state-lock path must name a regular file.");
    return NULL;
  }

  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    int lock_error = errno;
    close(fd);
    if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
      threadleaf_busy(env);
    } else {
      threadleaf_io(env, "Could not acquire the POSIX state-lock file.");
    }
    return NULL;
  }

  threadleaf_lock* lock = (threadleaf_lock*)calloc(1, sizeof(threadleaf_lock));
  if (!lock) {
    flock(fd, LOCK_UN);
    close(fd);
    threadleaf_io(env, "Could not allocate state-lock bookkeeping.");
    return NULL;
  }
  lock->fd = fd;
  lock->utf8_path = strdup(utf8_path);
  lock->identity = identity;
  if (!lock->utf8_path) {
    flock(fd, LOCK_UN);
    close(fd);
    free(lock);
    threadleaf_io(env, "Could not allocate state-lock path bookkeeping.");
    return NULL;
  }
  return lock;
}

static int threadleaf_verify_posix(threadleaf_lock* lock) {
  if (lock->closed) {
    return -2;
  }
  int final_missing = 0;
  int final_directory = 0;
  int final_symlink = 0;
  struct stat path_info;
  int path_fd = threadleaf_validate_posix_path(
      lock->utf8_path,
      0,
      &final_missing,
      &final_directory,
      &final_symlink,
      &path_info);
  if (path_fd < 0 || final_missing || final_directory || final_symlink) {
    return 0;
  }
  close(path_fd);
  threadleaf_identity current;
  if (!threadleaf_identity_from_stat(&path_info, &current)) {
    return 0;
  }
  return threadleaf_identity_equal(&lock->identity, &current) ? 1 : 0;
}

static int threadleaf_close_posix(threadleaf_lock* lock) {
  if (lock->closed) {
    return 1;
  }
  int unlocked = flock(lock->fd, LOCK_UN) == 0;
  int unlock_error = unlocked ? 0 : errno;
  int closed = close(lock->fd) == 0;
  lock->fd = -1;
  lock->closed = 1;
  (void)unlock_error;
  return unlocked && closed;
}

static void threadleaf_free_posix(threadleaf_lock* lock) {
  if (!lock) {
    return;
  }
  threadleaf_close_posix(lock);
  free(lock->utf8_path);
  free(lock);
}

#endif

static void threadleaf_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
#if defined(_WIN32)
  threadleaf_free_windows((threadleaf_lock*)data);
#else
  threadleaf_free_posix((threadleaf_lock*)data);
#endif
}

static napi_value threadleaf_lock_close(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, &this_arg, NULL) != napi_ok) {
    return threadleaf_io(env, "Could not read the state-lock receiver.");
  }
  threadleaf_lock* lock = NULL;
  if (napi_unwrap(env, this_arg, (void**)&lock) != napi_ok || !lock) {
    return threadleaf_invalid(env, "Invalid Threadleaf state-lock receiver.");
  }
  int closed;
#if defined(_WIN32)
  closed = threadleaf_close_windows(lock);
#else
  closed = threadleaf_close_posix(lock);
#endif
  if (!closed) {
    return threadleaf_error(
        env,
        "release-error",
        "StateLockReleaseError",
        "The state-lock handle could not be released cleanly.");
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return NULL;
  }
  return undefined;
}

static napi_value threadleaf_lock_verify(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, &this_arg, NULL) != napi_ok) {
    return threadleaf_io(env, "Could not read the state-lock receiver.");
  }
  threadleaf_lock* lock = NULL;
  if (napi_unwrap(env, this_arg, (void**)&lock) != napi_ok || !lock) {
    return threadleaf_invalid(env, "Invalid Threadleaf state-lock receiver.");
  }
  int status;
#if defined(_WIN32)
  status = threadleaf_verify_windows(lock);
#else
  status = threadleaf_verify_posix(lock);
#endif
  if (status == -2) {
    return threadleaf_closed(env);
  }
  if (status != 1) {
    return threadleaf_compromised(env);
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return NULL;
  }
  return undefined;
}

static napi_value threadleaf_acquire(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    return threadleaf_invalid(env, "State-lock acquire requires one path argument.");
  }

  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length > 32768) {
    return threadleaf_invalid(env, "State-lock path must be a non-empty UTF-8 string.");
  }
  char* path = (char*)calloc(length + 1, sizeof(char));
  if (!path) {
    return threadleaf_io(env, "Could not allocate the state-lock path.");
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, length + 1, &copied) != napi_ok ||
      copied != length || memchr(path, '\0', length) != NULL) {
    free(path);
    return threadleaf_invalid(env, "State-lock path must not contain NUL bytes.");
  }

  threadleaf_lock* lock;
#if defined(_WIN32)
  lock = threadleaf_native_acquire_windows(env, path);
#else
  lock = threadleaf_native_acquire_posix(env, path);
#endif
  free(path);
  if (!lock) {
    return NULL;
  }

  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) {
#if defined(_WIN32)
    threadleaf_free_windows(lock);
#else
    threadleaf_free_posix(lock);
#endif
    return threadleaf_io(env, "Could not allocate the state-lock object.");
  }
  if (napi_wrap(env, result, lock, threadleaf_finalize, NULL, NULL) != napi_ok) {
#if defined(_WIN32)
    threadleaf_free_windows(lock);
#else
    threadleaf_free_posix(lock);
#endif
    return threadleaf_io(env, "Could not retain the state-lock handle.");
  }
  napi_property_descriptor properties[] = {
      {"close", NULL, threadleaf_lock_close, NULL, NULL, NULL, napi_default, NULL},
      {"assertPathIdentity", NULL, threadleaf_lock_verify, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, result, 2, properties) != napi_ok) {
    return threadleaf_io(env, "Could not initialize the state-lock methods.");
  }
  return result;
}

static char* threadleaf_read_path_argument(
    napi_env env,
    napi_value value,
    const char* message) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > 32768) {
    threadleaf_filesystem_error(env, "invalid", message);
    return NULL;
  }
  char* result = (char*)calloc(length + 1, sizeof(char));
  if (!result) {
    threadleaf_filesystem_error(env, "io", "Could not allocate a native filesystem path.");
    return NULL;
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, result, length + 1, &copied) != napi_ok ||
      copied != length || memchr(result, '\0', length) != NULL) {
    free(result);
    threadleaf_filesystem_error(env, "invalid", message);
    return NULL;
  }
  return result;
}

/*
 * Atomically move one already-contained pathname to another without replacing
 * a target claimant. Linux renameat2 is the authority; other platforms fail
 * closed until an equivalent primitive is implemented and packaged there.
 */
static napi_value threadleaf_rename_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Native no-clobber rename requires source and target path arguments.");
  }
  char* source = threadleaf_read_path_argument(
      env, argv[0], "Native no-clobber rename source must be a non-empty UTF-8 path.");
  if (!source) {
    return NULL;
  }
  char* target = threadleaf_read_path_argument(
      env, argv[1], "Native no-clobber rename target must be a non-empty UTF-8 path.");
  if (!target) {
    free(source);
    return NULL;
  }

#if defined(__linux__) && defined(SYS_renameat2)
  int result = (int)syscall(
      SYS_renameat2,
      AT_FDCWD,
      source,
      AT_FDCWD,
      target,
      RENAME_NOREPLACE);
  int rename_error = result == 0 ? 0 : errno;
  free(source);
  free(target);
  if (result != 0) {
    if (rename_error == EEXIST) {
      return threadleaf_filesystem_error(
          env, "exists", "The native no-clobber rename target already exists.");
    }
    if (rename_error == ENOENT) {
      return threadleaf_filesystem_error(
          env, "missing", "The native no-clobber rename source or parent is missing.");
    }
    if (rename_error == EXDEV) {
      return threadleaf_filesystem_error(
          env, "cross-device", "The native no-clobber rename crossed filesystem devices.");
    }
    if (rename_error == ENOSYS || rename_error == EINVAL || rename_error == EOPNOTSUPP) {
      return threadleaf_filesystem_error(
          env,
          "unsupported",
          "The filesystem does not support atomic no-clobber rename.");
    }
    return threadleaf_filesystem_error(
        env, "io", "The native no-clobber rename did not complete.");
  }

  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return NULL;
  }
  return undefined;
#else
  free(source);
  free(target);
  return threadleaf_filesystem_error(
      env,
      "unsupported",
      "Atomic no-clobber rename is currently available only on Linux.");
#endif
}

/*
 * Prove that an already-open target directory can create and durably prepare
 * an anonymous publication inode without materializing any vault pathname.
 * This deliberately does not call linkat: final-basename publication remains
 * the authoritative no-clobber check because a probe name would either be
 * visible or need unsafe pathname cleanup.
 */
static napi_value threadleaf_probe_anonymous_publish_no_name(
    napi_env env,
    napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous publication probe requires an open directory descriptor.");
  }

  int32_t directory_fd = -1;
  if (napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0) {
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous publication probe requires an open directory descriptor.");
  }

#if defined(__linux__) && defined(O_TMPFILE)
  struct stat directory_stat;
  if (fstat(directory_fd, &directory_stat) != 0 || !S_ISDIR(directory_stat.st_mode)) {
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous publication probe descriptor is not an open directory.");
  }

  int temporary_fd = openat(
      directory_fd,
      ".",
      O_TMPFILE | O_RDWR | O_CLOEXEC,
      S_IRUSR | S_IWUSR);
  if (temporary_fd < 0) {
    int open_error = errno;
    if (open_error == EOPNOTSUPP || open_error == ENOTSUP || open_error == EINVAL ||
        open_error == EISDIR || open_error == ENOENT || open_error == EACCES ||
        open_error == EPERM) {
      return threadleaf_filesystem_error(
          env,
          "unsupported",
          "The target filesystem does not support anonymous temporary files.");
    }
    return threadleaf_filesystem_error(
        env,
        "io",
        "Could not create the anonymous attachment publication probe inode.");
  }

  const unsigned char probe_byte = 0;
  size_t offset = 0;
  int operation_error = 0;
  while (offset < sizeof(probe_byte)) {
    ssize_t written = write(
        temporary_fd,
        ((const char*)&probe_byte) + offset,
        sizeof(probe_byte) - offset);
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written <= 0) {
      operation_error = written == 0 ? EIO : errno;
      break;
    }
    offset += (size_t)written;
  }
  if (
      operation_error == 0 &&
      (fchmod(temporary_fd, S_IRUSR | S_IWUSR) != 0 || fsync(temporary_fd) != 0 ||
       fsync(directory_fd) != 0)) {
    operation_error = errno;
  }
  int close_result = close(temporary_fd);
  if (operation_error != 0) {
    return threadleaf_filesystem_error(
        env,
        "io",
        "Could not durably prepare the anonymous attachment publication probe inode.");
  }
  if (close_result != 0) {
    return threadleaf_filesystem_error(
        env,
        "io",
        "The anonymous attachment publication probe descriptor did not close cleanly.");
  }

  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return NULL;
  }
  return undefined;
#else
  return threadleaf_filesystem_error(
      env,
      "unsupported",
      "Anonymous publication probing is currently available only on Linux.");
#endif
}

/*
 * Materialize bytes into an unnamed inode on an already-open target
 * directory, then atomically link that inode at an absent basename. No
 * staging pathname exists for another process to replace before publication.
 */
static napi_value threadleaf_publish_buffer_no_replace(
    napi_env env,
    napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous no-clobber publication requires a directory descriptor, target basename, and Buffer.");
  }

  int32_t directory_fd = -1;
  if (napi_get_value_int32(env, argv[0], &directory_fd) != napi_ok || directory_fd < 0) {
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous no-clobber publication requires an open directory descriptor.");
  }
  char* target = threadleaf_read_path_argument(
      env, argv[1], "Anonymous no-clobber publication target must be a UTF-8 basename.");
  if (!target) {
    return NULL;
  }
  if (strcmp(target, ".") == 0 || strcmp(target, "..") == 0 || strchr(target, '/') != NULL) {
    free(target);
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous no-clobber publication target must contain one basename.");
  }
  void* bytes = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[2], &bytes, &length) != napi_ok) {
    free(target);
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous no-clobber publication content must be a Buffer.");
  }

#if defined(__linux__) && defined(O_TMPFILE) && defined(AT_EMPTY_PATH)
  struct stat directory_stat;
  if (fstat(directory_fd, &directory_stat) != 0 || !S_ISDIR(directory_stat.st_mode)) {
    free(target);
    return threadleaf_filesystem_error(
        env,
        "invalid",
        "Anonymous no-clobber publication descriptor is not an open directory.");
  }

  int temporary_fd = openat(
      directory_fd,
      ".",
      O_TMPFILE | O_RDWR | O_CLOEXEC,
      S_IRUSR | S_IWUSR);
  if (temporary_fd < 0) {
    int open_error = errno;
    free(target);
    if (open_error == EOPNOTSUPP || open_error == ENOTSUP || open_error == EINVAL ||
        open_error == EISDIR || open_error == ENOENT) {
      return threadleaf_filesystem_error(
          env,
          "unsupported",
          "The target filesystem does not support anonymous temporary files.");
    }
    if (open_error == EACCES || open_error == EPERM) {
      return threadleaf_filesystem_error(
          env,
          "unsupported",
          "The target directory rejected anonymous no-clobber publication.");
    }
    return threadleaf_filesystem_error(
        env,
        "io",
        "Could not create the anonymous attachment publication inode.");
  }

  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(temporary_fd, (const char*)bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written <= 0) {
      close(temporary_fd);
      free(target);
      return threadleaf_filesystem_error(
          env,
          "io",
          "Could not write the anonymous attachment publication inode.");
    }
    offset += (size_t)written;
  }
  if (fchmod(temporary_fd, S_IRUSR | S_IWUSR) != 0 || fsync(temporary_fd) != 0) {
    close(temporary_fd);
    free(target);
    return threadleaf_filesystem_error(
        env,
        "io",
        "Could not durably prepare the anonymous attachment publication inode.");
  }

  int result = linkat(temporary_fd, "", directory_fd, target, AT_EMPTY_PATH);
  int publish_error = result == 0 ? 0 : errno;
  if (
      result != 0 &&
      (publish_error == EPERM || publish_error == EACCES || publish_error == ENOENT)) {
    char descriptor_path[64];
    int descriptor_length = snprintf(
        descriptor_path,
        sizeof(descriptor_path),
        "/proc/self/fd/%d",
        temporary_fd);
    if (descriptor_length > 0 && (size_t)descriptor_length < sizeof(descriptor_path)) {
      result = linkat(
          AT_FDCWD,
          descriptor_path,
          directory_fd,
          target,
          AT_SYMLINK_FOLLOW);
      publish_error = result == 0 ? 0 : errno;
    }
  }
  if (result == 0 && fsync(directory_fd) != 0) {
    publish_error = errno;
    result = -1;
  }
  int close_result = close(temporary_fd);
  free(target);
  if (result != 0) {
    if (publish_error == EEXIST) {
      return threadleaf_filesystem_error(
          env,
          "exists",
          "The anonymous no-clobber publication target already exists.");
    }
    if (publish_error == EXDEV) {
      return threadleaf_filesystem_error(
          env,
          "cross-device",
          "The anonymous no-clobber publication crossed filesystem devices.");
    }
    if (publish_error == EOPNOTSUPP || publish_error == ENOTSUP || publish_error == ENOSYS ||
        publish_error == EINVAL || publish_error == EPERM || publish_error == EACCES ||
        publish_error == ENOENT) {
      return threadleaf_filesystem_error(
          env,
          "unsupported",
          "The runtime or filesystem rejected anonymous no-clobber publication.");
    }
    return threadleaf_filesystem_error(
        env,
        "io",
        "Anonymous no-clobber publication did not complete durably.");
  }
  if (close_result != 0) {
    return threadleaf_filesystem_error(
        env,
        "io",
        "The anonymous attachment publication descriptor did not close cleanly.");
  }

  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    return NULL;
  }
  return undefined;
#else
  free(target);
  return threadleaf_filesystem_error(
      env,
      "unsupported",
      "Anonymous no-clobber publication is currently available only on Linux.");
#endif
}

static napi_value threadleaf_platform(napi_env env, napi_callback_info info) {
  (void)info;
  const char* value;
#if defined(_WIN32)
  value = "windows";
#else
  value = "posix";
#endif
  napi_value result;
  if (napi_create_string_utf8(env, value, (size_t)-1, &result) != napi_ok) {
    return NULL;
  }
  return result;
}

static napi_value threadleaf_mechanism(napi_env env, napi_callback_info info) {
  (void)info;
  const char* value;
#if defined(_WIN32)
  value = "LockFileEx";
#else
  value = "flock";
#endif
  napi_value result;
  if (napi_create_string_utf8(env, value, (size_t)-1, &result) != napi_ok) {
    return NULL;
  }
  return result;
}

static napi_value threadleaf_napi_version(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  if (napi_create_string_utf8(env, "10", (size_t)-1, &result) != napi_ok) {
    return NULL;
  }
  return result;
}

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"acquire", NULL, threadleaf_acquire, NULL, NULL, NULL, napi_default, NULL},
      {"renameNoReplace", NULL, threadleaf_rename_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"probeAnonymousPublishNoName", NULL, threadleaf_probe_anonymous_publish_no_name, NULL, NULL, NULL, napi_default, NULL},
      {"publishBufferNoReplace", NULL, threadleaf_publish_buffer_no_replace, NULL, NULL, NULL, napi_default, NULL},
      {"platform", NULL, threadleaf_platform, NULL, NULL, NULL, napi_default, NULL},
      {"mechanism", NULL, threadleaf_mechanism, NULL, NULL, NULL, napi_default, NULL},
      {"napiVersion", NULL, threadleaf_napi_version, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 7, properties) != napi_ok) {
    return NULL;
  }
  return exports;
}

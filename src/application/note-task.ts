import {
  isCompletedMarkdownTaskStatus,
  normalizeMarkdownTaskStatus,
  type ParsedMarkdownTask,
  parseMarkdownTasks,
  toggleMarkdownTaskStatus,
} from "../kernel/markdown-tasks";
import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultReadPort } from "../kernel/ports";

export interface MarkdownTaskRecord {
  path: string;
  line: number;
  status: string;
  completed: boolean;
  text: string;
}

export interface MarkdownTaskSnapshot {
  task: MarkdownTaskRecord;
  revision: string;
}

export type MarkdownTaskMutation = { kind: "toggle" } | { kind: "set"; status: string };

export type MarkdownTaskMutationOutcome =
  | ({ status: "unchanged" } & MarkdownTaskSnapshot)
  | ({ status: "committed"; transactionId: string } & MarkdownTaskSnapshot)
  | {
      status: "conflict";
      task: MarkdownTaskRecord;
      currentRevision: string | null;
      conflictPath: string;
      transactionId: string;
    };

function taskRecord(path: string, task: ParsedMarkdownTask): MarkdownTaskRecord {
  return {
    path,
    line: task.line,
    status: task.status,
    completed: isCompletedMarkdownTaskStatus(task.status),
    text: task.text,
  };
}

function taskAtLine(path: string, content: string, line: number): ParsedMarkdownTask {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error("Task line must be a positive integer.");
  }
  const task = parseMarkdownTasks(content).find((candidate) => candidate.line === line);
  if (!task) {
    throw new Error(`No Markdown task exists at ${path}:${line}.`);
  }
  return task;
}

export async function listMarkdownTasks(
  vault: VaultReadPort,
  requestedPath?: string,
): Promise<MarkdownTaskRecord[]> {
  const allPaths = await vault.listMarkdownPaths();
  let paths = allPaths;
  if (requestedPath !== undefined) {
    const normalizedPath = normalizeMarkdownNotePath(requestedPath);
    if (!allPaths.includes(normalizedPath)) {
      throw new Error(`Markdown note is not indexed in this vault: ${normalizedPath}`);
    }
    paths = [normalizedPath];
  }
  const snapshots = await Promise.all(paths.map((filePath) => vault.readText(filePath)));
  return snapshots.flatMap((snapshot) =>
    parseMarkdownTasks(snapshot.content).map((task) => taskRecord(snapshot.path, task)),
  );
}

export async function readMarkdownTask(
  vault: VaultReadPort,
  requestedPath: string,
  line: number,
): Promise<MarkdownTaskSnapshot> {
  const path = normalizeMarkdownNotePath(requestedPath);
  const snapshot = await vault.readText(path);
  return {
    task: taskRecord(path, taskAtLine(path, snapshot.content, line)),
    revision: snapshot.revision,
  };
}

export async function mutateMarkdownTask(
  vault: VaultMutationPort,
  requestedPath: string,
  line: number,
  mutation: MarkdownTaskMutation,
): Promise<MarkdownTaskMutationOutcome> {
  const path = normalizeMarkdownNotePath(requestedPath);
  const snapshot = await vault.readText(path);
  const current = taskAtLine(path, snapshot.content, line);
  const nextStatus =
    mutation.kind === "toggle"
      ? toggleMarkdownTaskStatus(current.status)
      : normalizeMarkdownTaskStatus(mutation.status);
  const nextTask = taskRecord(path, { ...current, status: nextStatus });
  if (nextStatus === current.status) {
    return { status: "unchanged", task: nextTask, revision: snapshot.revision };
  }

  const content = `${snapshot.content.slice(0, current.statusStart)}${nextStatus}${snapshot.content.slice(current.statusEnd)}`;
  const result = await vault.writeText(path, content, snapshot.revision);
  if (result.status === "conflict") {
    return {
      status: "conflict",
      task: nextTask,
      currentRevision: result.currentRevision,
      conflictPath: result.conflictPath,
      transactionId: result.transactionId,
    };
  }
  return {
    status: "committed",
    task: nextTask,
    revision: result.revision,
    transactionId: result.transactionId,
  };
}

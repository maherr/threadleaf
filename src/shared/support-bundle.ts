export type SupportBundleExportResponse =
  | { status: "cancelled" }
  | { status: "saved" }
  | { status: "failed"; message: string };

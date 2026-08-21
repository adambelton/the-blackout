export interface ServiceStatus {
  name: string;
  status: "ok" | "error" | "unconfigured";
  message?: string;
}

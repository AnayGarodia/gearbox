export interface LogEntry { level: string; message: string; timestamp: number }

export function log(level: string, message: string): LogEntry {
  return { level, message, timestamp: Date.now() };
}

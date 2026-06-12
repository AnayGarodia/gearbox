export interface User {
  firstName?: string;
  lastName?: string;
}

export function getDisplayName(user: User | null | undefined): string {
  const parts = [user!.firstName, user!.lastName].filter(Boolean);
  return parts.join(" ");
}

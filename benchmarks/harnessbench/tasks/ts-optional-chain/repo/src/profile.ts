export interface User { address?: { city?: string } }
export function getCity(user: User | null | undefined): string | null {
  return user.address.city ?? null;
}

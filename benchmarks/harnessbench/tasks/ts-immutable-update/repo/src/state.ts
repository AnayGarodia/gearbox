export interface User { id: number; name: string; email: string; role: string }
export function updateUser(user: User, changes: Partial<User>): User {
  return Object.assign(user, changes);
}

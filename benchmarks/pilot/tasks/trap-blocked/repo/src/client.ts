// v1 API client. The v2 migration is specced in docs/api-spec-v2.md.
export interface User { id: string; name: string }
export async function getUser(id: string): Promise<User> {
  const r = await fetch(`/api/v1/users/${id}`);
  return (await r.json()) as User;
}

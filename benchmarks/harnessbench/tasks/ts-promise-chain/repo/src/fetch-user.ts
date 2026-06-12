export async function fetchUserName(
  id: number,
  getUser: (id: number) => Promise<{ id: number }>,
  getProfile: (id: number) => Promise<{ displayName: string }>,
): Promise<string> {
  try {
    const user = await getUser(id);
    const profile = await getProfile(user.id);
    return profile.displayName;
  } catch {
    return undefined as any;
  }
}

export interface User { id: string; name: string }
type Loader = (id: string) => Promise<User>;

export function createFetcher(loader: Loader) {
  return async function fetchUser(id: string): Promise<User> {
    return loader(id);
  };
}

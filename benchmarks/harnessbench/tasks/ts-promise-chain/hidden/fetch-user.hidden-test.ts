import { expect, test } from "bun:test";
import { fetchUserName } from "../src/fetch-user.ts";
test("resolves with displayName", async () => {
  const getUser = async (id: number) => ({ id: id * 10 });
  const getProfile = async (id: number) => ({ displayName: `user-${id}` });
  expect(await fetchUserName(3, getUser, getProfile)).toBe("user-30");
});
test("rejects when getUser rejects", async () => {
  const getUser = async () => { throw new Error("not found"); };
  const getProfile = async (id: number) => ({ displayName: "x" });
  await expect(fetchUserName(1, getUser, getProfile)).rejects.toThrow("not found");
});
test("rejects when getProfile rejects", async () => {
  const getUser = async (id: number) => ({ id });
  const getProfile = async () => { throw new Error("no profile"); };
  await expect(fetchUserName(1, getUser, getProfile)).rejects.toThrow("no profile");
});

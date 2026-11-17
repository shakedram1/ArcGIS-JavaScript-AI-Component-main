import test from "node:test";
import assert from "node:assert/strict";
import { baselineStore, visibilityChanges } from "../baseline";

test("visibilityChanges: restores what differs, ignores layers added later", () => {
  const base = { a: true, b: false, g: true };
  assert.deepEqual(
    visibilityChanges(base, [{ uid: "a", visible: false }, { uid: "b", visible: false }, { uid: "g", visible: true }, { uid: "new", visible: true }]),
    [{ uid: "a", visible: true }],
  );
  assert.deepEqual(visibilityChanges({}, [{ uid: "a", visible: false }]), []);
});

test("visibilityChanges: a layer the user toggled by hand goes back", () => {
  assert.deepEqual(visibilityChanges({ x: false }, [{ uid: "x", visible: true }]), [{ uid: "x", visible: false }]);
});

test("baselineStore: set, get, clear", () => {
  assert.equal(baselineStore.get(), null);
  baselineStore.set({ visibility: { a: true }, viewpointJson: null });
  assert.deepEqual(baselineStore.get(), { visibility: { a: true }, viewpointJson: null });
  baselineStore.clear();
  assert.equal(baselineStore.get(), null);
});

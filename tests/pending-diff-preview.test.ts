import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPendingEditPreviewData,
  buildPendingWritePreviewData,
} from "../src/pending-diff-preview.ts";

function withTempWorkspace(name: string, run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), name));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("pending write preview compares existing safe workspace files", () => {
  withTempWorkspace("pi-tool-display-write-preview-", (workspace) => {
    writeFileSync(join(workspace, "sample.txt"), "before\n", "utf8");

    const preview = buildPendingWritePreviewData(
      { path: "sample.txt", content: "after\n" },
      workspace,
    );

    assert.equal(preview?.fileExistedBeforeWrite, true);
    assert.equal(preview?.previousContent, "before\n");
    assert.equal(preview?.nextContent, "after\n");
    assert.equal(preview?.notice, undefined);
  });
});

test("pending preview accepts canonical aliases of the workspace root", () => {
  withTempWorkspace("pi-tool-display-canonical-", (workspace) => {
    const aliases = mkdtempSync(join(tmpdir(), "pi-tool-display-aliases-"));
    try {
      const alias = join(aliases, "workspace");
      symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
      writeFileSync(join(workspace, "sample.txt"), "before\n", "utf8");

      const preview = buildPendingWritePreviewData(
        { path: "sample.txt", content: "after\n" },
        alias,
      );
      const pendingCreate = buildPendingWritePreviewData(
        { path: join(alias, "missing.txt"), content: "new\n" },
        alias,
      );

      assert.equal(preview?.previousContent, "before\n");
      assert.equal(preview?.notice, undefined);
      assert.equal(pendingCreate?.fileExistedBeforeWrite, false);
      assert.equal(pendingCreate?.nextContent, "new\n");
      assert.equal(pendingCreate?.notice, undefined);
    } finally {
      rmSync(aliases, { recursive: true, force: true });
    }
  });
});

test("pending preview skips direct reads outside the workspace", () => {
  withTempWorkspace("pi-tool-display-boundary-", (workspace) => {
    const outside = mkdtempSync(join(tmpdir(), "pi-tool-display-outside-"));
    try {
      const outsideFile = join(outside, "secret.txt");
      writeFileSync(outsideFile, "secret\n", "utf8");

      const editPreview = buildPendingEditPreviewData(
        { path: outsideFile, oldText: "secret", newText: "safe" },
        workspace,
      );
      const writePreview = buildPendingWritePreviewData(
        { path: outsideFile, content: "replacement\n" },
        workspace,
      );

      assert.equal(editPreview?.previousContent, undefined);
      assert.equal(editPreview?.nextContent, undefined);
      assert.match(editPreview?.notice ?? "", /outside the current workspace/);
      assert.equal(writePreview?.previousContent, undefined);
      assert.equal(writePreview?.nextContent, "replacement\n");
      assert.match(writePreview?.notice ?? "", /outside the current workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("pending preview rejects workspace symlinks that resolve outside", () => {
  withTempWorkspace("pi-tool-display-symlink-boundary-", (workspace) => {
    const outside = mkdtempSync(join(tmpdir(), "pi-tool-display-symlink-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret\n", "utf8");
      symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");

      const preview = buildPendingEditPreviewData(
        { path: "escape/secret.txt", oldText: "secret", newText: "safe" },
        workspace,
      );
      const missingPreview = buildPendingWritePreviewData(
        { path: "escape/missing.txt", content: "new\n" },
        workspace,
      );

      assert.equal(preview?.previousContent, undefined);
      assert.equal(preview?.nextContent, undefined);
      assert.match(preview?.notice ?? "", /resolves outside the current workspace/);
      assert.equal(missingPreview?.previousContent, undefined);
      assert.match(missingPreview?.notice ?? "", /resolves outside the current workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(
  "pending preview rejects dangling symlinks that target outside",
  { skip: process.platform === "win32" },
  () => {
    withTempWorkspace("pi-tool-display-dangling-boundary-", (workspace) => {
      const outside = mkdtempSync(join(tmpdir(), "pi-tool-display-dangling-outside-"));
      try {
        symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling.txt"), "file");

        const preview = buildPendingWritePreviewData(
          { path: "dangling.txt", content: "new\n" },
          workspace,
        );

        assert.equal(preview?.previousContent, undefined);
        assert.match(preview?.notice ?? "", /resolves outside the current workspace/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  },
);

test("pending preview skips files over the read-size limit", () => {
  withTempWorkspace("pi-tool-display-large-preview-", (workspace) => {
    mkdirSync(join(workspace, "nested"));
    const nestedFile = join(workspace, "nested", "large.txt");
    writeFileSync(nestedFile, "x".repeat(1_000_001), "utf8");

    const preview = buildPendingEditPreviewData(
      { path: "nested/large.txt", oldText: "x", newText: "y" },
      workspace,
    );

    assert.equal(preview?.previousContent, undefined);
    assert.equal(preview?.nextContent, undefined);
    assert.match(preview?.notice ?? "", /preview read limit/);
  });
});

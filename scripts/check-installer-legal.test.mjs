import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLegal, checkSystem } from "./check-installer-legal.mjs";

const expected = { notices: "the notices\n", license: "GNU AFFERO GENERAL PUBLIC LICENSE\n" };
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function installer(files) {
  const dir = mkdtempSync(join(tmpdir(), "legal-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const full = (prefix) => ({
  [`${prefix}/LICENSE`]: expected.license,
  [`${prefix}/THIRD-PARTY-NOTICES`]: expected.notices,
});

describe("checkLegal", () => {
  it("accepts an installer with everything, also with Windows line ends", () => {
    const dir = installer({ ...full("App"), "App/LICENSE": expected.license.replace(/\n/g, "\r\n") });
    expect(checkLegal("windows", dir, expected)).toEqual([]);
  });
  it("accepts a deb with the copyright file", () => {
    const dir = installer({
      ...full("usr/lib/Nimble Newt"),
      "usr/share/doc/nimble-newt/copyright": expected.license,
      "usr/share/doc/nimble-newt/THIRD-PARTY-NOTICES": expected.notices,
    });
    expect(checkLegal("linux", dir, expected)).toEqual([]);
  });
  it("wants the copyright file and the notices in the doc folder of a deb", () => {
    const dir = installer(full("usr/lib/Nimble Newt"));
    const problems = checkLegal("linux", dir, expected).join("\n");
    expect(problems).toContain("copyright");
    expect(problems).toContain("usr/share/doc/nimble-newt/THIRD-PARTY-NOTICES is not in the deb");
  });
  it("finds a missing notices file, a stale one and a wrong licence", () => {
    const none = installer({ "A/LICENSE": expected.license });
    expect(checkLegal("macos", none, expected)).toEqual(["THIRD-PARTY-NOTICES is not in the installer"]);
    const stale = installer({ ...full("A"), "A/THIRD-PARTY-NOTICES": "old" });
    expect(checkLegal("macos", stale, expected)[0]).toContain("not the THIRD-PARTY-NOTICES");
    const wrong = installer({ ...full("A"), "A/LICENSE": "MIT" });
    expect(checkLegal("macos", wrong, expected)[0]).toContain("not the LICENSE");
  });
  it("finds a missing AGPL text", () => {
    const dir = installer({ "A/THIRD-PARTY-NOTICES": expected.notices });
    expect(checkLegal("windows", dir, expected)).toEqual(["LICENSE (the AGPL text) is not in the installer"]);
  });
});

describe("checkSystem (each installer format on its own)", () => {
  const windows = (msi, nsis) => installer({ ...msi, ...nsis });
  it("passes when msi and nsis both carry everything", () => {
    expect(checkSystem("windows", windows(full("msi/PFiles/App"), full("nsis")), expected)).toEqual([]);
  });
  it("fails when only the msi lacks the notices, although the nsis has them", () => {
    const msi = full("msi/PFiles/App");
    delete msi["msi/PFiles/App/THIRD-PARTY-NOTICES"];
    const problems = checkSystem("windows", windows(msi, full("nsis")), expected);
    expect(problems).toEqual(["msi: THIRD-PARTY-NOTICES is not in the installer"]);
  });
  it("fails when only the nsis lacks the AGPL text, although the msi has it", () => {
    const nsis = full("nsis");
    delete nsis["nsis/LICENSE"];
    const problems = checkSystem("windows", windows(full("msi/PFiles/App"), nsis), expected);
    expect(problems).toEqual(["nsis: LICENSE (the AGPL text) is not in the installer"]);
  });
  it("fails when a format was not unpacked at all", () => {
    const problems = checkSystem("windows", windows(full("msi/PFiles/App"), {}), expected);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nsis: the nsis installer was not unpacked");
  });
  it("checks the deb and the dmg as their own formats", () => {
    expect(checkSystem("macos", installer(full("dmg/App.app/Contents/Resources")), expected)).toEqual([]);
    expect(checkSystem("macos", installer(full("msi/x")), expected)[0]).toContain("dmg: the dmg installer was not unpacked");
    expect(checkSystem("linux", installer(full("deb/usr/lib/Nimble Newt")), expected).join("\n")).toContain("deb: usr/share/doc/nimble-newt/copyright");
  });
});

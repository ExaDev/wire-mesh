#!/usr/bin/env python3
"""Checks that rust/deny.toml, the declared rust-version and the workflows that enforce them say what is true.

Run from anywhere; it reads `cargo metadata` for the real dependency graph. Exits 1 and prints each problem when:
- an allowlist or skip entry is out of order, repeated, missing, stale, or its reason carries a number;
- a "pulled in by" or "kept by" reason names crates that are not the real parents, or "first of them" does not list the first three;
- a setting of deny.toml that the selftest cannot exercise differs from the policy;
- the workspace rust-version is not the highest any dependency needs, or the rust-version CI job uses another toolchain;
- an action in any workflow is not pinned to a full commit SHA;
- the required cargo-deny job checks advisories, or the required set is wrong.
"""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent
repo = root.parent
problems = []

deny = (root / "deny.toml").read_text()
uncommented = "\n".join(l for l in deny.splitlines() if not l.lstrip().startswith("#"))


def section(name):
    start = uncommented.index("[%s]" % name)
    end = re.search(r"^\[", uncommented[start + 1:], re.M)
    return uncommented[start: start + 1 + end.start()] if end else uncommented[start:]


def list_entries(text, key):
    match = re.search(r"^%s = \[\n(.*?)^\]" % key, text, re.M | re.S)
    return re.findall(r'\{ (?:crate|id) = "([^"]+)", reason = "([^"]*)" \}', match.group(1))


bans = section("bans")
allow = list_entries(bans, "allow")
skip = list_entries(bans, "skip")
ignores = list_entries(section("advisories"), "ignore")

# Settings that no cargo-deny run would notice being loosened unless the selftest or this script asserts them.
expected = {
    "graph": ['all-features = true'],
    "advisories": ['yanked = "deny"'],
    "sources": ['unknown-registry = "deny"', 'unknown-git = "deny"',
                'allow-registry = ["https://github.com/rust-lang/crates.io-index"]', "allow-git = []"],
    "bans": ['multiple-versions = "deny"', 'wildcards = "deny"', "allow-wildcard-paths = true"],
}
for name, lines in expected.items():
    text = section(name)
    for line in lines:
        if line not in text.splitlines():
            problems.append("deny.toml [%s] must contain: %s" % (name, line))
copyleft = re.compile(r"GPL|MPL|EPL|CDDL|SSPL|OSL", re.I)
for licence in re.findall(r'"([^"]+)",', section("licenses")):
    if copyleft.search(licence):
        problems.append("deny.toml allows a copyleft licence: %s" % licence)

names = [name for name, _ in allow]
if names != sorted(set(names)):
    problems.append("bans allow entries are not unique and in alphabetical order")
skipped = [name for name, _ in skip]
if skipped != sorted(set(skipped)):
    problems.append("bans skip entries are not unique and in alphabetical order")

number = re.compile(r"(?<![A-Za-z0-9_.-])v?\d+(\.\d+)*(?![A-Za-z0-9_-])")
for kind, entries in (("allow", allow), ("skip", skip), ("ignore", ignores)):
    for name, reason in entries:
        if number.search(reason):
            problems.append("%s reason for %s carries a number that goes stale: %r" % (kind, name, reason))

meta = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--format-version", "1", "--all-features"], cwd=root))
packages = {p["id"]: p for p in meta["packages"]}
workspace = set(meta["workspace_members"])
nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
reachable = set()
stack = [d["pkg"] for w in workspace for d in nodes[w]["deps"]]
while stack:
    pkg = stack.pop()
    if pkg in reachable or pkg in workspace:
        continue
    reachable.add(pkg)
    stack.extend(d["pkg"] for d in nodes[pkg]["deps"])
in_graph = {packages[p]["name"] for p in reachable} | {packages[w]["name"] for w in workspace}
parents = {}
for pkg in reachable:
    for dep in nodes[pkg]["deps"]:
        if dep["pkg"] in reachable:
            parents.setdefault(dep["pkg"], set()).add(packages[pkg]["name"])
parents_of_name = {}
for pkg, ps in parents.items():
    parents_of_name.setdefault(packages[pkg]["name"], set()).update(ps)


def expect_parents(label, name, reason, prefix, many, real):
    real = sorted(real)
    if len(real) <= 4:
        want = "%s %s" % (prefix, ", ".join(real))
    else:
        want = "%s, first of them %s" % (many, ", ".join(real[:3]))
    if reason != want:
        problems.append("%s reason for %s is %r, the parents say %r" % (label, name, reason, want))


for name in sorted(in_graph - set(names)):
    problems.append("%s is in the dependency graph but not in the allowlist" % name)
for name in sorted(set(names) - in_graph):
    problems.append("%s is in the allowlist but not in the dependency graph" % name)
for name, reason in allow:
    if reason.startswith(("pulled in by", "shared by many")):
        expect_parents("allow", name, reason, "pulled in by", "shared by many dependencies",
                       parents_of_name.get(name, set()))
for name, reason in skip:
    crate, _, version = name.partition("@")
    ids = [p for p in reachable if packages[p]["name"] == crate and packages[p]["version"] == version]
    if len(ids) != 1:
        problems.append("skip entry %s matches no crate version in the graph" % name)
        continue
    expect_parents("skip", name, reason, "older release kept by", "older release kept by many dependencies",
                   parents.get(ids[0], set()))

# rust-version must be the highest any dependency of the workspace needs.


def version_tuple(text):
    parts = [int(x) for x in text.split(".")] + [0, 0]
    return tuple(parts[:3])


needs = [(version_tuple(packages[p]["rust_version"]), packages[p]["name"])
         for p in reachable if packages[p].get("rust_version")]
floor = max(needs)[0]
declared = {packages[w]["rust_version"] for w in workspace}
if len(declared) != 1:
    problems.append("workspace members declare different rust-version values: %s" % sorted(declared, key=str))
else:
    declared_version = next(iter(declared))
    if declared_version is None or version_tuple(declared_version) != floor:
        problems.append("rust-version is %s but the highest any dependency needs is %s (%s)" % (
            declared_version, ".".join(map(str, floor[:2])), max(needs)[1]))

sha = re.compile(r"@[0-9a-f]{40}( |$)")


def job_block(text, job):
    start = re.search(r"^  %s:\n" % re.escape(job), text, re.M)
    end = re.search(r"^  \S", text[start.end():], re.M)
    return text[start.start(): start.end() + (end.start() if end else len(text))]


workflows = sorted((repo / ".github/workflows").glob("*.yml"))
for workflow in workflows:
    for line in re.findall(r"^\s*-?\s*uses: (\S.*)$", workflow.read_text(), re.M):
        if line.startswith("./"):
            continue
        if "@" not in line or not sha.search("@" + line.split("@", 1)[1]):
            problems.append("%s: action not pinned to a commit SHA: %s" % (workflow.name, line))

ci = (repo / ".github/workflows/ci.yml").read_text()
msrv_job = job_block(ci, "rust-version")
toolchain = re.search(r'toolchain: "?([0-9.]+)"?', msrv_job)
if toolchain is None or version_tuple(toolchain.group(1)) != floor:
    problems.append("the rust-version CI job must use toolchain %s" % ".".join(map(str, floor[:2])))

deny_job = job_block(ci, "cargo-deny")
if "advisories" in re.sub(r"^\s*#.*$", "", deny_job, flags=re.M):
    problems.append("the required cargo-deny job must not check advisories")
required = re.search(r"required-checks:\n\s+name:.*\n\s+needs:\n?\s*\[([^\]]*)\]", ci)
needed = {x.strip() for x in required.group(1).split(",") if x.strip()} if required else set()
for job in ("cargo-deny", "rust-version", "rust-verify"):
    if job not in needed:
        problems.append("required-checks must need the %s job" % job)
if any("advisories" in job for job in needed):
    problems.append("the advisories job must stay outside required-checks")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("deny policy checks passed")

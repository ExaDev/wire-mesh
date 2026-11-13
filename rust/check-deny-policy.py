#!/usr/bin/env python3
"""Checks that rust/deny.toml and the workflows that enforce it say what is true.

Run from anywhere; it reads `cargo metadata` for the real dependency graph. Exits 1 and prints each problem when:
- an allowlist entry is out of alphabetical order, repeated, or carries a count in its reason;
- a "pulled in by" reason names crates that are not the crate's real parents;
- a crate in the graph is missing from the allowlist, or an entry names a crate that is not in the graph;
- an action in a Rust workflow job is not pinned to a full commit SHA;
- the required cargo-deny job checks advisories, or the advisories job is part of required-checks.
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
allow_block = deny[deny.index("allow = [\n", deny.index("[bans]")):]
entries = re.findall(r'\{ crate = "([^"]+)", reason = "([^"]*)" \}', allow_block)
names = [name for name, _ in entries]
if names != sorted(set(names)):
    problems.append("bans allow entries are not unique and in alphabetical order")
for name, reason in entries:
    if re.search(r"\b(and|\+)\s*\d+\s+(other|more)\b", reason):
        problems.append("reason for %s carries a count that goes stale: %r" % (name, reason))

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
            parents.setdefault(packages[dep["pkg"]]["name"], set()).add(packages[pkg]["name"])

for name in sorted(in_graph - set(names)):
    problems.append("%s is in the dependency graph but not in the allowlist" % name)
for name in sorted(set(names) - in_graph):
    problems.append("%s is in the allowlist but not in the dependency graph" % name)
for name, reason in entries:
    match = re.fullmatch(r"pulled in by (.+)", reason)
    if match:
        named = set(match.group(1).split(", "))
        if named != parents.get(name, set()):
            problems.append("reason for %s names %s, real parents are %s" % (
                name, sorted(named), sorted(parents.get(name, set()))))
    elif reason.startswith("shared by many dependencies"):
        if len(parents.get(name, set())) <= 4:
            problems.append("%s has few parents, so its reason should list them" % name)

sha = re.compile(r"@[0-9a-f]{40}( |$)")


def job_block(text, job):
    start = re.search(r"^  %s:\n" % re.escape(job), text, re.M)
    end = re.search(r"^  \S", text[start.end():], re.M)
    return text[start.start(): start.end() + (end.start() if end else len(text))]


ci = (repo / ".github/workflows/ci.yml").read_text()
advisories = (repo / ".github/workflows/rust-advisories.yml").read_text()
checked = {
    "ci.yml rust-verify": job_block(ci, "rust-verify"),
    "ci.yml cargo-deny": job_block(ci, "cargo-deny"),
    "rust-advisories.yml": advisories,
}
for label, text in checked.items():
    for line in re.findall(r"^\s*-?\s*uses: (\S.*)$", text, re.M):
        if not sha.search("@" + line.split("@", 1)[1]):
            problems.append("%s: action not pinned to a commit SHA: %s" % (label, line))

deny_job = job_block(ci, "cargo-deny")
if "advisories" in re.sub(r"^\s*#.*$", "", deny_job, flags=re.M):
    problems.append("the required cargo-deny job must not check advisories")
needs = re.search(r"required-checks:\n\s+name:.*\n\s+needs:\n?\s*\[([^\]]*)\]", ci)
if needs is None or "cargo-deny" not in needs.group(1):
    problems.append("required-checks must need the cargo-deny job")
if "advisories" in (needs.group(1) if needs else ""):
    problems.append("the advisories job must stay outside required-checks")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("deny policy checks passed")

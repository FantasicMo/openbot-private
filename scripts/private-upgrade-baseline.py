"""Fetch a pinned, previously accepted private package on a disposable CI runner."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile


BASELINES = {
    "windows": {
        "runId": 41188467812,
        "artifactId": 13037872319,
        "artifactName": "private-windows-fe73b8506af784873219e41e6758e78f8905de29-41188467812-1",
        "commit": "fe73b8506af784873219e41e6758e78f8905de29",
        "workflow": ".github/workflows/private-windows-candidate.yml",
        "job": "Build, install and launch private Windows x64",
        "file": "OpenBot-Private-0.56.0-x64.exe",
        "sha256": "51e55bb3182b2c43c954589983245813da2202b2680122cd1964c86972be1e4e",
    },
    "android": {
        "runId": 41185911155,
        "artifactId": 13038201558,
        "artifactName": "private-android-build-41185911155-1",
        "commit": "ade0c7cb71c37101f65f0906b64fe701c1153b3f",
        "workflow": ".github/workflows/private-android-candidate.yml",
        "job": "Build signed APK candidate",
        "file": "openbot-private.apk",
        "sha256": "ba6a54d92cfbf75c1a4c91aa54ef32c981ebd97605c23781ca0ce83cb5fbbc87",
        "versionCode": 1003,
    },
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=BASELINES)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        parser.error("This command requires a disposable GitHub-hosted runner.")
    if os.environ.get("GITHUB_REPOSITORY", "").lower() != "fantasicmo/openbot-private":
        parser.error("The pinned baseline belongs to FantasicMo/openbot-private.")
    root = args.output_dir.resolve()
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve()
    if root == temporary or temporary not in root.parents or root.exists():
        parser.error("Use a new baseline directory below RUNNER_TEMP.")
    baseline = BASELINES[args.platform]
    repository = os.environ["GITHUB_REPOSITORY"]

    def api(path):
        result = subprocess.run(["gh", "api", f"repos/{repository}/{path}"], capture_output=True, check=True, timeout=60)
        return json.loads(result.stdout)

    run = api(f"actions/runs/{baseline['runId']}")
    artifact = api(f"actions/artifacts/{baseline['artifactId']}")
    source = artifact.get("workflow_run", {})
    repo_id = int(os.environ["GITHUB_REPOSITORY_ID"])
    if run["id"] != baseline["runId"] or run["head_sha"] != baseline["commit"] or run["path"] != baseline["workflow"] or run["event"] != "workflow_dispatch":
        raise RuntimeError("The pinned baseline run provenance does not match.")
    if artifact["id"] != baseline["artifactId"] or artifact["name"] != baseline["artifactName"] or artifact["expired"]:
        raise RuntimeError("The pinned baseline artifact is unavailable or does not match.")
    if source.get("id") != baseline["runId"] or source.get("repository_id") != repo_id or source.get("head_repository_id") != repo_id or source.get("head_sha") != baseline["commit"]:
        raise RuntimeError("The baseline artifact must come from this repository and pinned commit.")
    jobs = api(f"actions/runs/{baseline['runId']}/attempts/1/jobs?per_page=100")["jobs"]
    matches = [job for job in jobs if job["name"] == baseline["job"]]
    if len(matches) != 1 or matches[0]["conclusion"] != "success" or matches[0]["head_sha"] != baseline["commit"]:
        raise RuntimeError("The pinned package build job did not pass.")
    build_job_id = matches[0]["id"]
    root.mkdir()
    archive = root / "baseline.zip"
    with archive.open("xb") as destination:
        subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/{baseline['artifactId']}/zip"], stdout=destination, stderr=subprocess.PIPE, check=True, timeout=180)
    package = root / baseline["file"]
    try:
        with zipfile.ZipFile(archive) as zipped:
            matches = [entry for entry in zipped.infolist() if entry.filename == baseline["file"]]
            if len(matches) != 1 or not 1 <= matches[0].file_size <= 1024 * 1024 * 1024:
                raise RuntimeError("The pinned package is absent or has an invalid size.")
            # Extract one exact basename. Do not extract arbitrary paths from the archive.
            with zipped.open(matches[0]) as source_file, package.open("xb") as destination:
                for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                    destination.write(chunk)
    finally:
        archive.unlink(missing_ok=True)
    with package.open("rb") as source_file:
        digest = hashlib.file_digest(source_file, "sha256").hexdigest()
    if digest != baseline["sha256"]:
        raise RuntimeError("The baseline package hash does not match the accepted bytes.")
    report = {
        "schema": 1, "repository": repository, "platform": args.platform,
        **baseline, "buildJobId": build_job_id,
        "artifactDigest": artifact.get("digest"), "validatorCommit": os.environ["GITHUB_SHA"],
        "validatorRunId": os.environ["GITHUB_RUN_ID"], "passed": True,
    }
    (root / "baseline-provenance.json").write_text(json.dumps(report, indent=2) + "\n")
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as environment:
        environment.write(f"PRIVATE_UPGRADE_BASELINE={package}\n")
        environment.write(f"PRIVATE_UPGRADE_BASELINE_SHA256={digest}\n")
    print(json.dumps({"platform": args.platform, "sha256": digest, "passed": True}))


if __name__ == "__main__":
    main()

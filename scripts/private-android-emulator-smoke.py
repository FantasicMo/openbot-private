"""Check a signed APK on a disposable GitHub-hosted Android emulator. Never rebuild it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile


PACKAGE = "io.github.fantasicmo.openbot"
SERIAL = "emulator-5554"
CHAIN = "OPENBOT_PRIVATE_SMOKE"


def apk_signer_certificate_fingerprint(signature, expected):
    """Accept legacy and Build Tools 37 signer labels; keep every app signer pinned."""
    certificate = re.sub(r":", "", expected).strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", certificate):
        raise RuntimeError("The expected APK certificate fingerprint is missing.")
    # AOSP Android 17 signer-label source:
    # https://android.googlesource.com/platform/tools/apksig/+/refs/heads/android17-release/src/apksigner/java/com/android/apksigner/ApkSignerTool.java#763
    # Source-format example, not a captured candidate: V3.0 Signer: certificate SHA-256 digest: <hex>
    # Rotation can add an SDK range after the signer label.
    # Source Stamp certificates identify the stamp, not the application's signer.
    pattern = re.compile(
        r"(?:V[123](?:\.\d+)? )?Signer(?: #\d+)?:?(?: \([^\r\n]+\))?"
        r" certificate SHA-256 digest: ([a-fA-F0-9]{64})[ \t]*"
    )
    fingerprints = set()
    for line in signature.splitlines():
        if "certificate SHA-256 digest:" not in line:
            continue
        if re.fullmatch(r"Source Stamp Signer:? certificate SHA-256 digest: [a-fA-F0-9]{64}[ \t]*", line):
            continue
        match = pattern.fullmatch(line)
        if match is None:
            raise RuntimeError("The APK certificate output has an unsupported signer label.")
        fingerprints.add(match.group(1).lower())
    if not fingerprints:
        raise RuntimeError("The APK certificate output contains no application signer.")
    if fingerprints != {certificate}:
        raise RuntimeError(
            "The APK certificate does not match the private release signer. "
            f"Expected SHA-256: {certificate}; actual SHA-256: {', '.join(sorted(fingerprints))}."
        )
    return certificate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-dir", required=True, type=Path)
    parser.add_argument("--avd", default="openbot-private-smoke")
    parser.add_argument("--observe-seconds", type=int, default=30)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or sys.platform != "linux":
        parser.error("This command requires a disposable GitHub-hosted Linux runner.")
    if args.observe_seconds < 30 or args.observe_seconds > 120:
        parser.error("The observation window must be from 30 to 120 seconds.")

    candidate = args.candidate_dir.resolve()
    output = candidate / "emulator"
    output.mkdir(parents=True, exist_ok=True)
    sdk = Path(os.environ["ANDROID_HOME"])
    adb = sdk / "platform-tools" / "adb"
    emulator = sdk / "emulator" / "emulator"
    apk = candidate / "openbot-private.apk"
    process = None
    app_uid = None
    configured_tables = []
    report = {
        "schema": 1,
        "passed": False,
        "scope": "signed_release_apk_private_first_run_without_metro_or_host_pairing",
        "commit": os.environ.get("GITHUB_SHA"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "steps": [],
        "network": {
            "scope": "App UID IPv4/IPv6 OUTPUT packet attempts, rejected before launch",
            "observationSeconds": args.observe_seconds,
            "instrumented": False,
            "unverified": [
                "JavaScript/native API invocations that produce no IP packet.",
                "DNS delegated to netd, isolated processes, and Google Play services or other UIDs.",
                "Behavior after the observation window, pairing, and a real host session.",
            ],
        },
        "unverified": [
            "Private host pairing, TLS trust, provider execution, task results, files and reconnect.",
            "ARM64 phone, Clash Mi coexistence, camera and vendor background behavior.",
        ],
    }

    def run(command, timeout=40, check=True):
        return subprocess.run([str(part) for part in command], capture_output=True, timeout=timeout, check=check)

    def device(*command, timeout=40, check=True):
        return run([adb, "-s", SERIAL, *command], timeout, check)

    def shell(*command, timeout=40, check=True):
        return device("shell", *command, timeout=timeout, check=check).stdout.decode("utf-8", "replace").strip()

    def record(name, operation):
        operation()
        report["steps"].append({"name": name, "passed": True})

    def screen(name):
        device("shell", "uiautomator", "dump", "--compressed", "/sdcard/openbot-private-window.xml")
        result = device("exec-out", "cat", "/sdcard/openbot-private-window.xml").stdout
        (output / f"{name}.xml").write_bytes(result)
        (output / f"{name}.png").write_bytes(device("exec-out", "screencap", "-p").stdout)
        return ET.fromstring(result)

    def await_screen(name, predicate, timeout=60):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            tree = screen(name)
            if predicate(tree):
                return tree
            if not shell("pidof", PACKAGE, check=False):
                raise RuntimeError("The private app stopped before the expected screen appeared.")
            time.sleep(1)
        raise RuntimeError(f"The expected {name} UI did not appear before its deadline.")

    def texts(tree):
        return [node.get(key, "") for node in tree.iter("node") for key in ("text", "content-desc", "hint")]

    def tap(node):
        bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
        if not bounds:
            raise RuntimeError("The UI target has no usable bounds.")
        left, top, right, bottom = map(int, bounds.groups())
        shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))

    try:
        def verify_apk():
            expected = (candidate / "SHA256SUMS").read_text().strip()
            digest = hashlib.sha256(apk.read_bytes()).hexdigest()
            if expected != f"{digest}  openbot-private.apk":
                raise RuntimeError("The downloaded APK differs from the build artifact hash.")
            report["apkSha256"] = digest
            with zipfile.ZipFile(apk) as archive:
                if archive.getinfo("assets/index.android.bundle").file_size == 0:
                    raise RuntimeError("The release APK has no embedded JavaScript.")
            tools = sorted((sdk / "build-tools").iterdir(), key=lambda path: tuple(map(int, re.findall(r"\d+", path.name))))[-1]
            signature = run([tools / "apksigner", "verify", "--verbose", "--print-certs", apk]).stdout.decode()
            (output / "signature.txt").write_text(signature)
            certificate = apk_signer_certificate_fingerprint(signature, os.environ.get("CERT_SHA256", ""))
            report["certificateSha256"] = certificate

        record("same_signed_release_apk_hash_and_embedded_bundle", verify_apk)
        with socket.socket() as probe:
            probe.settimeout(1)
            if probe.connect_ex(("127.0.0.1", 8081)) == 0:
                raise RuntimeError("Port 8081 is in use. This check must run without Metro.")
        if SERIAL in run([adb, "devices"]).stdout.decode():
            raise RuntimeError("The smoke emulator serial is already in use.")
        emulator_log = (output / "emulator.log").open("wb")
        process = subprocess.Popen([
            str(emulator), "-avd", args.avd, "-port", "5554", "-no-window", "-no-audio",
            "-no-boot-anim", "-no-snapshot", "-wipe-data", "-gpu", "swiftshader_indirect",
            "-accel", "on", "-cores", "2", "-memory", "3072", "-no-metrics",
        ], stdout=emulator_log, stderr=subprocess.STDOUT)
        device("wait-for-device", timeout=180)
        end = time.monotonic() + 180
        while shell("getprop", "sys.boot_completed", check=False) != "1":
            if time.monotonic() > end or process.poll() is not None:
                raise RuntimeError("The emulator did not finish booting.")
            time.sleep(2)
        device("root")
        device("wait-for-device")
        if shell("id", "-u") != "0":
            raise RuntimeError("The test image must allow root for app-UID packet counters.")
        shell("input", "keyevent", "82")
        for setting in ("window_animation_scale", "transition_animation_scale", "animator_duration_scale"):
            shell("settings", "put", "global", setting, "0")
        shell("settings", "put", "secure", "show_ime_with_hard_keyboard", "0")
        device("reverse", "--remove-all")
        device("install", "--no-streaming", str(apk), timeout=180)
        package_info = shell("dumpsys", "package", PACKAGE)
        (output / "package.txt").write_text(package_info)
        if "DEBUGGABLE" in package_info:
            raise RuntimeError("The candidate must be a non-debuggable release APK.")
        uid_match = re.search(r"\buid:(\d+)\b", shell("cmd", "package", "list", "packages", "-U", PACKAGE))
        if not uid_match or int(uid_match.group(1)) < 10000:
            raise RuntimeError("The candidate application UID could not be identified safely.")
        app_uid = uid_match.group(1)
        for table in ("iptables", "ip6tables"):
            shell(table, "-w", "5", "-N", CHAIN)
            configured_tables.append(table)
            shell(table, "-w", "5", "-A", CHAIN, "-j", "REJECT")
            shell(table, "-w", "5", "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", app_uid, "-j", CHAIN)
        report["network"]["instrumented"] = True
        report["network"]["appUid"] = int(app_uid)
        record("release_installed_with_app_uid_egress_blocked", lambda: None)
        activity = shell("cmd", "package", "resolve-activity", "--brief", PACKAGE).splitlines()[-1]
        if not re.fullmatch(re.escape(PACKAGE) + r"/[A-Za-z0-9_.$]+", activity):
            raise RuntimeError("The private launcher activity could not be resolved.")
        device("logcat", "-c")
        start = time.monotonic()
        launched = shell("am", "start", "-W", "-S", "-n", activity, timeout=90)
        (output / "launch.txt").write_text(launched)
        if "Status: ok" not in launched:
            raise RuntimeError("The release launcher did not report a successful start.")
        first = await_screen("private-first-run", lambda tree: "Private hosts" in texts(tree) and "Pairing link or JSON" in texts(tree))
        for forbidden in ("Sign in with email", "Sign in to OpenBot", "Continue with Google"):
            if forbidden in texts(first):
                raise RuntimeError("An official account sign-in screen appeared in private mode.")
        record("cold_start_private_pairing_screen_without_account_or_metro", lambda: None)
        field = next((node for node in first.iter("node") if node.get("class", "").endswith("EditText")), None)
        if field is None:
            raise RuntimeError("The private pairing input is missing.")
        tap(field)
        shell("input", "text", "private-smoke-invalid-offer")
        filled = await_screen("pairing-input", lambda tree: "private-smoke-invalid-offer" in texts(tree), timeout=20)
        record("private_pairing_input_accepts_text", lambda: None)
        button = next((node for node in filled.iter("node") if node.get("text") == "Pair host" or node.get("content-desc") == "Pair host"), None)
        if button is None:
            raise RuntimeError("The private pairing action is missing.")
        tap(button)
        await_screen("invalid-offer", lambda tree: "This private pairing offer is invalid." in texts(tree), timeout=20)
        record("invalid_offer_fails_locally_without_official_login", lambda: None)
        while time.monotonic() - start < args.observe_seconds:
            time.sleep(1)
        if not shell("pidof", PACKAGE, check=False):
            raise RuntimeError("The release app stopped during startup observation.")
        report["network"]["actualObservationSeconds"] = round(time.monotonic() - start, 1)
        for table in configured_tables:
            counters = shell(table, "-w", "5", "-L", CHAIN, "-n", "-v", "-x")
            (output / f"{table}.txt").write_text(counters)
            rejected = re.findall(r"^\s*(\d+)\s+\d+\s+REJECT\s", counters, re.MULTILINE)
            if len(rejected) != 1:
                raise RuntimeError("The app-UID packet counter could not be read.")
            report["network"][table + "PacketAttempts"] = int(rejected[0])
            if int(rejected[0]) != 0:
                raise RuntimeError("The unpaired private app attempted IP egress during startup.")
        record("no_app_uid_ip_egress_observed_during_startup_window", lambda: None)
        screen("startup-complete")
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        try:
            screen("failure")
        except Exception:
            pass
    finally:
        if process is not None:
            try:
                pid = shell("pidof", PACKAGE, check=False).split()
                if pid:
                    (output / "app-logcat.txt").write_bytes(device("logcat", "-d", "-v", "threadtime", "--pid=" + pid[0], check=False).stdout)
                (output / "crash-logcat.txt").write_bytes(device("logcat", "-d", "-b", "crash", check=False).stdout)
                (output / "device.txt").write_text(shell("getprop"))
                for table in configured_tables:
                    shell(table, "-w", "5", "-D", "OUTPUT", "-m", "owner", "--uid-owner", app_uid, "-j", CHAIN, check=False)
                    shell(table, "-w", "5", "-F", CHAIN, check=False)
                    shell(table, "-w", "5", "-X", CHAIN, check=False)
                device("emu", "kill", check=False)
            except Exception:
                pass
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
            emulator_log.close()
        after = hashlib.sha256(apk.read_bytes()).hexdigest() if apk.exists() else None
        report["apkSha256AfterSmoke"] = after
        if after != report.get("apkSha256"):
            report["passed"] = False
            report["error"] = "The candidate APK hash changed during smoke validation."
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"passed": report["passed"], "report": str(output / "report.json")}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

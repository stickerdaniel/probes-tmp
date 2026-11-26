import ctypes as c
import json
import os
import subprocess
import sys
from pathlib import Path

MIB = 1024**2

if sys.platform == "win32":
    from ctypes import wintypes as w

    kernel = c.WinDLL("kernel32", use_last_error=True)
    psapi = c.WinDLL("psapi", use_last_error=True)
    SIZE_T = c.c_size_t

    class Counters(c.Structure):
        _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD)] + [
            (name, SIZE_T) for name in (
                "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage",
            )
        ]

    class BasicLimits(c.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", c.c_int64), ("PerJobUserTimeLimit", c.c_int64),
            ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", SIZE_T),
            ("MaximumWorkingSetSize", SIZE_T), ("ActiveProcessLimit", w.DWORD),
            ("Affinity", SIZE_T), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD),
        ]

    class ExtendedLimits(c.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits), ("IoInfo", c.c_uint64 * 6),
            ("ProcessMemoryLimit", SIZE_T), ("JobMemoryLimit", SIZE_T),
            ("PeakProcessMemoryUsed", SIZE_T), ("PeakJobMemoryUsed", SIZE_T),
        ]

    def declare(dll, name, returns, *arguments):
        fn = getattr(dll, name)
        fn.restype = returns
        fn.argtypes = arguments
        return fn

    open_process = declare(kernel, "OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    close_handle = declare(kernel, "CloseHandle", w.BOOL, w.HANDLE)
    create_job = declare(kernel, "CreateJobObjectW", w.HANDLE, c.c_void_p, w.LPCWSTR)
    set_job = declare(kernel, "SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
    query_job = declare(kernel, "QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p)
    assign = declare(kernel, "AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
    memory_info = declare(psapi, "GetProcessMemoryInfo", w.BOOL, w.HANDLE, c.POINTER(Counters), w.DWORD)

    def check(result, operation):
        if not result:
            code = c.get_last_error()
            raise OSError(code, f"{operation}: {c.FormatError(code).strip()}")
        return result

elif sys.platform == "darwin":
    libproc = c.CDLL("/usr/lib/libproc.dylib")
    libproc.proc_pidinfo.argtypes = (c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int)
    libproc.proc_pidinfo.restype = c.c_int


def sample(pid, handle=None):
    if sys.platform == "win32":
        process = handle or open_process(0x410, False, pid)
        if not process:
            return {"rssBytes": 0}
        try:
            counters = Counters()
            counters.cb = c.sizeof(counters)
            if not memory_info(process, c.byref(counters), c.sizeof(counters)):
                return {"rssBytes": 0}
            return dict(rssBytes=counters.WorkingSetSize, peakBytes=counters.PeakWorkingSetSize,
                        privateBytes=counters.PrivateUsage)
        finally:
            if not handle:
                close_handle(process)
    if sys.platform == "darwin":
        data = (c.c_uint64 * 20)()
        length = libproc.proc_pidinfo(pid, 4, 0, data, c.sizeof(data))
        return dict(rssBytes=data[1], virtualBytes=data[0]) if length >= 16 else {"rssBytes": 0}
    if sys.platform == "linux":
        keys = {"VmRSS": "rssBytes", "VmHWM": "peakBytes", "VmSize": "virtualBytes"}
        stats = {"rssBytes": 0}
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                key, _, value = line.partition(":")
                if key in keys:
                    stats[keys[key]] = int(value.split()[0]) * 1024
        except ProcessLookupError:
            pass
        except FileNotFoundError:
            pass
        return stats
    raise RuntimeError(f"Unsupported platform {sys.platform}")


def set_limit(pid, jobs):
    if sys.platform == "win32":
        job = check(create_job(None, None), "CreateJobObjectW")
        try:
            info = ExtendedLimits()
            info.BasicLimitInformation.LimitFlags = 0x100 | 0x2000
            info.ProcessMemoryLimit = 256 * MIB
            check(set_job(job, 9, c.byref(info), c.sizeof(info)), "SetInformationJobObject")
            process = check(open_process(0x101, False, pid), "OpenProcess")
            try:
                check(assign(job, process), "AssignProcessToJobObject")
            finally:
                close_handle(process)
        except Exception:
            close_handle(job)
            raise
        jobs[pid] = job
        return dict(type="JOB_OBJECT_LIMIT_PROCESS_MEMORY", bytes=info.ProcessMemoryLimit)
    if sys.platform == "linux":
        import resource

        baseline = sample(pid)["virtualBytes"]
        initial = resource.prlimit(pid, resource.RLIMIT_AS)
        limit = baseline + 128 * MIB
        if initial[1] != resource.RLIM_INFINITY:
            limit = min(limit, initial[1])
        resource.prlimit(pid, resource.RLIMIT_AS, (limit, limit))
        applied = resource.prlimit(pid, resource.RLIMIT_AS)
        return dict(type="RLIMIT_AS", baselineBytes=baseline, before=initial, applied=applied)
    raise RuntimeError("OS hard limit was scoped to Windows and Linux")


def privileged(*command, value=None):
    prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
    result = subprocess.run([*prefix, *command], input=value, text=True, capture_output=True, timeout=5)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{command[0]} exited {result.returncode}")


def set_cgroup(pid, groups):
    path = Path(f"/sys/fs/cgroup/interpreter-probe-{os.getpid()}-{pid}")
    privileged("mkdir", str(path))
    groups[pid] = path
    cap = 256 * MIB
    privileged("tee", str(path / "memory.max"), value=f"{cap}\n")
    privileged("tee", str(path / "memory.swap.max"), value="0\n")
    privileged("tee", str(path / "cgroup.procs"), value=f"{pid}\n")
    return {
        "type": "cgroup-v2",
        "memoryMaxBytes": int((path / "memory.max").read_text()),
        "memorySwapMaxBytes": int((path / "memory.swap.max").read_text()),
        "workerJoined": str(pid) in (path / "cgroup.procs").read_text().split(),
    }


def cgroup_peak(path):
    return {
        "memoryPeakBytes": int((path / "memory.peak").read_text()),
        "memoryCurrentBytes": int((path / "memory.current").read_text()),
        "events": {key: int(value) for key, value in (
            line.split() for line in (path / "memory.events").read_text().splitlines()
        )},
    }


def peak(pid, jobs):
    if sys.platform != "win32":
        return sample(pid)
    info = ExtendedLimits()
    check(query_job(jobs[pid], 9, c.byref(info), c.sizeof(info), None), "QueryInformationJobObject")
    return {"jobPeakProcessBytes": info.PeakProcessMemoryUsed}


def monitor():
    jobs = {}
    groups = {}
    try:
        for line in sys.stdin:
            request = json.loads(line)
            op, pids = request["op"], request["pids"]
            try:
                if op == "sample":
                    answer = {"samples": [sample(pid) for pid in pids]}
                elif op == "limit":
                    answer = {"limit": set_limit(pids[0], jobs)}
                elif op == "cgroup":
                    answer = {"limit": set_cgroup(pids[0], groups)}
                elif op == "cgroup-peak":
                    answer = {"limit": cgroup_peak(groups[pids[0]])}
                elif op == "peak":
                    answer = {"limit": peak(pids[0], jobs)}
                else:
                    raise ValueError(op)
            except (OSError, RuntimeError, KeyError, subprocess.TimeoutExpired) as exc:
                answer = {"error": str(exc)}
            print(json.dumps(answer), flush=True)
    finally:
        for job in jobs.values():
            close_handle(job)
        for path in groups.values():
            try:
                privileged("rmdir", str(path))
            except RuntimeError as exc:
                print(str(exc), file=sys.stderr)

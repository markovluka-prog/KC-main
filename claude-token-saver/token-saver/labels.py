"""Самообучающиеся метки: какие строки лога Claude реально использовал.

Источник — transcript сессии (путь приходит в Stop-хук). Строка считается «нужной», если
  * Claude процитировал в своих сообщениях/вызовах инструментов редкий идентификатор из неё
    (путь, имя теста, номер, CamelCase/snake_case), либо
  * Claude прогнал grep/rg/sed по сохранённому логу и строка попала в выдачу.
Метки шумные, но бесплатные и берутся из реального поведения.
"""
import json
import os
import re
import shlex
from datetime import datetime

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_./\\:-]*[A-Za-z0-9_]|\d{3,}")
MAX_DF = 3          # токен «редкий», если встречается в ≤ 3 строках лога
MAX_GREP_HITS = 100  # слишком широкий grep — это разведка, а не цитата


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


TAIL_BYTES = 4_000_000  # нужен только хвост: текущий ход и последний usage


def _tail_lines(path):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - TAIL_BYTES))
        raw = f.read().decode("utf-8", errors="replace").split("\n")
    return raw[1:] if size > TAIL_BYTES else raw   # первая строка хвоста обрезана


def parse_transcript(path):
    """-> (entries, usage). entries: [(ts|None, текст, [bash-команды])] только от ассистента.
    Читается только хвост файла: время на ход не растёт вместе с длиной сессии."""
    entries, usage = [], None
    try:
        lines = _tail_lines(path)
    except Exception:
        return entries, usage
    for line in lines:
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        msg = o.get("message") if isinstance(o.get("message"), dict) else {}
        if (msg.get("role") or o.get("type")) != "assistant":
            continue
        if isinstance(msg.get("usage"), dict):
            usage = msg["usage"]
        texts, cmds = [], []
        content = msg.get("content")
        if isinstance(content, str):
            texts.append(content)
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                texts.append(b.get("text", ""))
            elif t == "thinking":
                texts.append(b.get("thinking", ""))
            elif t == "tool_use":
                inp = b.get("input") or {}
                texts.append(json.dumps(inp, ensure_ascii=False))
                if b.get("name") == "Bash" and isinstance(inp.get("command"), str):
                    cmds.append(inp["command"])
        entries.append((_ts(o.get("timestamp", "")), "\n".join(texts), cmds))
    return entries, usage


def after(entries, ts):
    """Сообщения ассистента после момента ts -> (тексты, команды)."""
    texts, cmds = [], []
    for t, tx, cm in entries:
        if t is None or t >= ts:
            texts.append(tx)
            cmds.extend(cm)
    return texts, cmds


def _tokens(text):
    out = set()
    for m in IDENT.finditer(text):
        t = m.group().lower().rstrip(".:")
        if t.isdigit():
            if len(t) >= 3:
                out.add(t)
        elif len(t) >= 5 and (re.search(r"[\d_./\\:-]", t) or re.search(r"[a-z][A-Z]", m.group())):
            out.add(t)
    return out


def distinctive(texts):
    out = set()
    for tx in texts:
        out |= _tokens(tx)
    return out


def cited_lines(lines, tokens):
    """Индексы (с 0) строк, содержащих редкий токен, который назвал Claude."""
    if not tokens:
        return set()
    hits = {}
    for i, ln in enumerate(lines):
        for t in _tokens(ln) & tokens:
            hits.setdefault(t, []).append(i)
    res = set()
    for idxs in hits.values():
        if len(idxs) <= MAX_DF:
            res.update(idxs)
    return res


def command_labels(cmds, logname, lines):
    """Строки, которые Claude вытащил из сохранённого лога grep/rg/sed -n."""
    res = set()
    for c in cmds:
        if logname not in c:
            continue
        try:
            t = shlex.split(c)
        except ValueError:
            continue
        exe = os.path.basename(t[0]) if t else ""
        if exe in ("grep", "rg", "egrep"):
            pat = None
            if "-e" in t and t.index("-e") + 1 < len(t):
                pat = t[t.index("-e") + 1]
            else:
                pos = [a for a in t[1:] if not a.startswith("-")]
                pat = pos[0] if pos else None
            if not pat or logname in pat:
                continue
            flags = re.I if ("-i" in t or "--ignore-case" in t) else 0
            try:
                rx = re.compile(pat, flags)
            except re.error:
                rx = re.compile(re.escape(pat), flags)
            hit = {i for i, ln in enumerate(lines) if rx.search(ln)}
            if len(hit) <= MAX_GREP_HITS:
                res |= hit
        elif exe == "sed":
            for a in t[1:]:
                m = re.fullmatch(r"(\d+),(\d+)p", a)
                if m and int(m.group(2)) - int(m.group(1)) <= 200:
                    res.update(range(int(m.group(1)) - 1, min(int(m.group(2)), len(lines))))
    return res


def context_tokens(usage):
    """Размер контекста по usage последнего ответа ассистента."""
    if not isinstance(usage, dict):
        return None
    total = sum(int(usage.get(k) or 0) for k in
                ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    return total or None

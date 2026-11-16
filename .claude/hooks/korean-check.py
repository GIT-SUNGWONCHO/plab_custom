#!/usr/bin/env python3
"""Stop 훅: 마지막 답변이 한국어 위주가 아니면 끝내지 못하게 막고 한국어로 다시 쓰게 함.

- 코드 블록·인라인 코드·URL·경로는 빼고 글자만 셈
- 한글 비율이 30% 미만이면 block (글자가 아주 적은 짧은 답은 통과)
- 이미 한 번 막아서 다시 쓰는 중(stop_hook_active)이면 통과 → 무한 반복 방지
"""
import json, re, sys

def last_assistant_text(path):
    texts = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return ""
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        msg = e.get("message") or {}
        role = msg.get("role") or e.get("type")
        content = msg.get("content")
        if role == "user":
            # 사람이 쓴 메시지(문자열)가 나오면 거기까지가 이번 턴
            if isinstance(content, str) or (isinstance(content, list) and any(c.get("type") == "text" for c in content if isinstance(c, dict))):
                break
            continue
        if role == "assistant" and isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    texts.append(c.get("text", ""))
            if texts:
                break  # 마지막 assistant 텍스트 블록만 검사
    return "\n".join(reversed(texts))

def main():
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):
        return
    text = last_assistant_text(data.get("transcript_path", ""))
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"https?://\S+|[\w./-]+/[\w./-]+", " ", text)
    hangul = len(re.findall(r"[가-힣]", text))
    latin_words = len(re.findall(r"[A-Za-z]{2,}", text))
    if hangul + latin_words < 15:
        return
    ratio = hangul / (hangul + latin_words * 3)  # 영어 단어 하나 ≈ 한글 3글자
    if ratio < 0.3:
        print(json.dumps({
            "decision": "block",
            "reason": "사용자에게 하는 답변은 반드시 한국어로 써야 합니다 (CLAUDE.md 규칙). 방금 답변을 같은 내용으로 한국어로 다시 써 주세요.",
        }, ensure_ascii=False))

if __name__ == "__main__":
    main()

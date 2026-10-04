// 字符级 LCS 差异：冲突卡片里标出两份译文/时间码的具体差异
export interface DiffSegment {
  text: string;
  type: "same" | "add" | "del";
}

export function diffChars(a: string, b: string): DiffSegment[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segments: DiffSegment[] = [];
  const push = (text: string, type: DiffSegment["type"]) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ text, type });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push(a[i], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(a[i], "del");
      i++;
    } else {
      push(b[j], "add");
      j++;
    }
  }
  while (i < m) {
    push(a[i], "del");
    i++;
  }
  while (j < n) {
    push(b[j], "add");
    j++;
  }
  return segments;
}

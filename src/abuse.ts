import SensitiveWordTool from "sensitive-word-tool";

const EXTRA = [
  "傻逼",
  "傻比",
  "傻b",
  "煞笔",
  "沙雕",
  "傻屌",
  "脑残",
  "白痴",
  "蠢货",
  "混蛋",
  "浑蛋",
  "王八蛋",
  "王八羔子",
  "狗东西",
  "狗屎",
  "狗屁",
  "狗日的",
  "狗娘养的",
  "操你妈",
  "肏你妈",
  "草你妈",
  "草泥马",
  "曹你妈",
  "操尼玛",
  "你妈的",
  "你妈逼",
  "他妈的",
  "特么的",
  "尼玛",
  "妈了个逼",
  "婊子",
  "贱人",
  "骚货",
  "荡妇",
  "死全家",
  "全家死",
  "去死",
  "滚你妈",
  "滚犊子",
  "装逼",
  "装比",
  "二逼",
  "二比",
  "傻叉",
  "傻缺",
  "弱智",
  "杂种",
  "畜生",
  "人渣",
  "cnmb",
  "nmsl",
  "wdnmd",
  "shabi",
  "caonima",
];

const tool = new SensitiveWordTool({ useDefaultWords: true });
tool.addWords(EXTRA);

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maskAbuse(input: string): string {
  const hits = tool.match(input);
  if (!hits.length) return input;
  const words = [...new Set(hits)].sort((a, b) => [...b].length - [...a].length);
  let text = input;
  for (const word of words) {
    if (!word) continue;
    text = text.replace(new RegExp(escapeRegExp(word), "gi"), "*".repeat([...word].length));
  }
  return text;
}

import SensitiveWordTool from "sensitive-word-tool";

const EXTRA = [
  // 常见侮辱
  "傻逼",
  "傻比",
  "傻b",
  "傻B",
  "傻福",
  "傻狗",
  "傻卵",
  "傻批",
  "傻子",
  "煞笔",
  "沙雕",
  "沙比",
  "沙壁",
  "沙币",
  "傻屌",
  "傻叉",
  "傻缺",
  "智障",
  "低能",
  "低能儿",
  "脑残",
  "白痴",
  "蠢货",
  "蠢猪",
  "蠢驴",
  "废物",
  "混蛋",
  "浑蛋",
  "混账",
  "混帐",
  "王八",
  "王八蛋",
  "王八羔子",
  "狗东西",
  "狗屎",
  "狗屁",
  "狗日的",
  "狗娘养的",
  "狗杂种",
  "狗杂碎",
  "狗逼",
  "狗b",
  "狗比",
  "杂种",
  "杂碎",
  "野种",
  "畜生",
  "畜牲",
  "禽兽",
  "人渣",
  "败类",
  "婊子",
  "表子",
  "贱人",
  "贱货",
  "贱逼",
  "骚货",
  "骚逼",
  "骚b",
  "骚比",
  "浪货",
  "烂货",
  "破鞋",
  "荡妇",
  // 亲属与性侮辱
  "叫爹",
  "叫爸爸",
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
  "妈了个巴子",
  "妈卖批",
  "死全家",
  "全家死",
  "死妈",
  "死爹",
  "去死",
  "滚你妈",
  "滚犊子",
  "滚蛋",
  "装逼",
  "装比",
  "二逼",
  "二比",
  "日你妈",
  "日你娘",
  "操你娘",
  "操你祖宗",
  "草你祖宗",
  // 缩写与网络骂法
  "cnmb",
  "nmsl",
  "wdnmd",
  "shabi",
  "caonima",
  "tmd",
  "nmb",
  "cnm",
  "mdzz",
  "mmp",
  "卧槽",
  "我操",
  "我草",
  // 英语与谐音
  "fuck",
  "fucking",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "motherfucker",
  "cunt",
  "dick",
  "pussy",
  "idiot",
  "moron",
  "retard",
  "法克",
  "碧池",
  "谢特",
  "俊福",
];

const tool = new SensitiveWordTool({ useDefaultWords: true });
tool.addWords(EXTRA);

// 只匹配独立出现的 sb，避免把 absb、yusb 这类单词一起打掉。
const STANDALONE_SB = /(?<![A-Za-z0-9])sb(?![A-Za-z0-9])/gi;
const NOISE = /[\s\p{P}\p{S}]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSegment(segment: string): string {
  let result = "";
  for (const char of segment) result += NOISE.test(char) ? char : "*";
  return result;
}

export function maskAbuse(input: string): string {
  let text = input;
  try {
    const hits = [...new Set(tool.match(input))].sort(
      (a, b) => [...b].length - [...a].length,
    );
    for (const hit of hits) {
      if (!hit) continue;
      const pattern = new RegExp(
        [...hit].map(escapeRegExp).join("[\\s\\p{P}\\p{S}]*"),
        "giu",
      );
      text = text.replace(pattern, maskSegment);
    }
  } catch {
    text = input;
  }
  return text.replace(STANDALONE_SB, (hit) => "*".repeat([...hit].length));
}

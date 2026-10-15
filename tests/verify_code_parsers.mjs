import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractWorkCodes, normalizeWorkCode, workCodeKey } from "../lib/code-parser.js";

const CASES = [
  {
    name: "FANZA CID without delimiter",
    input: "SSNI00644.mp4",
    code: "SSNI-644",
    codes: ["SSNI-644"],
    key: "ssni644"
  },
  {
    name: "FC2 PPV with leading zeroes and quality noise",
    input: "FC2-PPV-001234567 1080p.mp4",
    code: "FC2-PPV-1234567",
    codes: ["FC2-PPV-1234567"],
    key: "fc2ppv1234567"
  },
  {
    name: "FC2 PPV followed by title text",
    input: "fc2ppv_1181414完全顔出し.mp4",
    code: "FC2-PPV-1181414",
    codes: ["FC2-PPV-1181414"],
    key: "fc2ppv1181414"
  },
  {
    name: "HEYZO underscore",
    input: "HEYZO_0123.mp4",
    code: "HEYZO-123",
    codes: ["HEYZO-123"],
    key: "heyzo123"
  },
  {
    name: "HEYDOUGA full two-part code",
    input: "HEYDOUGA-4017-123.mp4",
    code: "HEYDOUGA-4017-123",
    codes: ["HEYDOUGA-4017-123"],
    key: "heydouga4017123"
  },
  {
    name: "Date-style 1Pondo code",
    input: "1pondo-123456_789.mp4",
    code: "123456-789",
    codes: ["123456-789"],
    key: "123456789"
  },
  {
    name: "Caribbeancom site prefix ignored",
    input: "Caribbeancom 123456-789",
    code: "123456-789",
    codes: ["123456-789"],
    key: "123456789"
  },
  {
    name: "Multipart suffix does not change work code",
    input: "ABC-123-CD1.mp4",
    code: "ABC-123",
    codes: ["ABC-123"],
    key: "abc123"
  },
  {
    name: "Quality, subtitle and site noise ignored",
    input: "[中文字幕] www.example.com ABP-647 1080p.mp4",
    code: "ABP-647",
    codes: ["ABP-647"],
    key: "abp647"
  },
  {
    name: "Bracketed code is preserved",
    input: "(元山はるか)美乳若妻の誘い はるか[APAA-186].wmv",
    code: "APAA-186",
    codes: ["APAA-186"],
    key: "apaa186"
  },
  {
    name: "Site domain prefix does not outrank code",
    input: "@蜂鳥@FENGNIAO131.VIP-MIAA-291_2K.mp4",
    code: "MIAA-291",
    codes: ["MIAA-291"],
    key: "miaa291"
  },
  {
    name: "Site domain with spaced separator is ignored",
    input: "2048论坛@fun2048.com - @AP-755.mp4",
    code: "AP-755",
    codes: ["AP-755"],
    key: "ap755"
  },
  {
    name: "HEYZO filename with quality tokens",
    input: "heyzo_lt_1380_full.mp4",
    code: "HEYZO-1380",
    codes: ["HEYZO-1380"],
    key: "heyzo1380"
  },
  {
    name: "Leading site number before code is ignored",
    input: "[Woxav.Com]229SCUTE-1014 豊乳ロリっ子と深く繋がるSEX.mp4",
    code: "SCUTE-1014",
    codes: ["SCUTE-1014"],
    key: "scute1014"
  },
  {
    name: "Bracketed code followed by release date prefers code",
    input: "[MOODYZ DIVA] Hitomi(田中瞳) [MIDD751][11.03.13].avi",
    code: "MIDD-751",
    codes: ["MIDD-751"],
    key: "midd751"
  },
  {
    name: "Special VR prefix",
    input: "3DSVR0012.mp4",
    code: "3DSVR-012",
    codes: ["3DSVR-012"],
    key: "3dsvr012"
  },
  {
    name: "TokyoHot site prefix ignored",
    input: "TOKYOHOT-n1234.mp4",
    code: "N-1234",
    codes: ["N-1234"],
    key: "n1234"
  },
  {
    name: "Uncensored date id",
    input: "082713-417.mp4",
    code: "082713-417",
    codes: ["082713-417"],
    key: "082713417"
  },
  {
    name: "Plain calendar date is ignored",
    input: "My movie 2024-01-02.mp4",
    code: "",
    codes: [],
    key: ""
  }
];

const pythonProbe = `
import json, sys
sys.path.insert(0, "tools")
from code_parser import normalize_code, extract_codes, loose_code_key

cases = json.load(sys.stdin)
json.dump([
    {
        "input": case["input"],
        "code": normalize_code(case["input"]),
        "codes": extract_codes(case["input"]),
        "key": loose_code_key(case["input"]),
    }
    for case in cases
], sys.stdout, ensure_ascii=False)
`;

const pythonResults = JSON.parse(
  execFileSync("python", ["-B", "-c", pythonProbe], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    input: JSON.stringify(CASES),
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }
  })
);

const failures = [];

for (const [index, testCase] of CASES.entries()) {
  const js = {
    input: testCase.input,
    code: normalizeWorkCode(testCase.input),
    codes: extractWorkCodes(testCase.input),
    key: workCodeKey(testCase.input)
  };
  const py = pythonResults[index];
  assertEqual(`${testCase.name} JS code`, js.code, testCase.code);
  assertEqual(`${testCase.name} JS codes`, js.codes, testCase.codes);
  assertEqual(`${testCase.name} JS key`, js.key, testCase.key);
  assertEqual(`${testCase.name} Python code`, py.code, testCase.code);
  assertEqual(`${testCase.name} Python codes`, py.codes, testCase.codes);
  assertEqual(`${testCase.name} Python key`, py.key, testCase.key);
  assertEqual(`${testCase.name} JS/Python parity`, js, py);
}

if (failures.length) {
  console.error(`code parser verification failed (${failures.length})`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`code parser verification passed (${CASES.length} cases)`);

function assertEqual(label, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    failures.push(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

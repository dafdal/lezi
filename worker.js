// ============================================================
// AI乐子 中转站 (Cloudflare Worker)
// 功能：接收网页请求 -> 联网搜索(维基/必应) -> AI 回答 -> 返回
// 无需任何 API Key：使用 Cloudflare 内置免费 AI 模型
// 可选：设置环境变量 ZHIPU_KEY 后自动改用智谱 GLM-4-Flash（质量更好）
// 部署后把 *.workers.dev 地址填进网页设置即可
// ============================================================
const SYSTEM = "你是AI乐子，大风大浪集团开发的网页聊天机器人。用简体中文、口语化、简短有趣地回复用户，回答不超过150字。";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
}

// 联网搜索：先维基（结构化，稳），没结果再抓必应
async function webSearch(text) {
  const kw = text.slice(0, 60);
  // 1) 中文维基百科
  try {
    const u = "https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent(kw) + "&format=json&srlimit=1&utf8=1";
    const s = await fetch(u, { headers: { "User-Agent": "AILezi/1.0" } });
    if (s.ok) {
      const j = await s.json();
      const title = j.query && j.query.search && j.query.search[0] && j.query.search[0].title;
      if (title) {
        const su = "https://zh.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
        const sm = await fetch(su, { headers: { "User-Agent": "AILezi/1.0" } });
        if (sm.ok) {
          const sj = await sm.json();
          if (sj && sj.extract) return "【网络资料】" + sj.extract.slice(0, 500);
        }
      }
    }
  } catch (e) {}
  // 2) 必应搜索抓取
  try {
    const bu = "https://cn.bing.com/search?q=" + encodeURIComponent(kw) + "&setlang=zh-hans";
    const b = await fetch(bu, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" } });
    if (b.ok) {
      const html = await b.text();
      const items = [];
      const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
      let m;
      while ((m = re.exec(html)) !== null && items.length < 3) {
        const strip = (x) => (x || "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").trim().slice(0, 130);
        const t = strip(m[1]);
        const d = strip(m[2]);
        if (t) items.push(t + (d ? "：" + d : ""));
      }
      if (items.length) return "【网络资料】" + items.join(" | ").slice(0, 600);
    }
  } catch (e) {}
  return "";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders() });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/chat") {
      try {
        const body = await request.json();
        const text = (body && body.text || "").toString().trim();
        if (!text) return new Response(JSON.stringify({ ok: false, error: "empty" }), { status: 400, headers: corsHeaders() });
        if (text.length > 500) return new Response(JSON.stringify({ ok: false, error: "too long" }), { status: 400, headers: corsHeaders() });

        // 联网搜索
        const info = await webSearch(text);

        // 组装提示词
        let userContent = text;
        if (info) {
          userContent = info + "\n【问题】" + text + "\n请优先根据上面的网络资料回答，资料不相关时直接回答。";
        }

        let reply = "";

        // 优先：智谱 GLM-4-Flash（免费，质量好）——配置了环境变量 ZHIPU_KEY 时使用
        if (env.ZHIPU_KEY) {
          try {
            const r = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
              method: "POST",
              headers: { "Authorization": "Bearer " + env.ZHIPU_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "glm-4-flash",
                messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userContent }],
                max_tokens: 512, stream: false
              })
            });
            if (r.ok) {
              const j = await r.json();
              reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim();
            }
          } catch (e) {}
        }

        // 兜底：Cloudflare 内置免费 AI（无需任何 Key）
        if (!reply && env.AI) {
          try {
            const r = await env.AI.run("@cf/qwen/qwen1.5-14b-chat-awq", {
              messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userContent }],
              max_tokens: 512
            });
            reply = (r && r.response || "").trim();
          } catch (e) {}
        }

        if (!reply) {
          return new Response(JSON.stringify({ ok: false, error: "model unavailable" }), { status: 503, headers: corsHeaders() });
        }
        return new Response(JSON.stringify({ ok: true, reply: reply }), { headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: corsHeaders() });
      }
    }
    return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: corsHeaders() });
  }
};

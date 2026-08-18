/**
 * dsh-cost-dashboard browser bundle.
 *
 * Registers two entry points:
 * - a settings section (费用看板) via `settings.section`;
 * - a sidebar footer action with a dashboard icon via `sidebar.footer.action`
 *   that opens the same dashboard in an anchored panel (the settings nav icons
 *   are hardcoded by the dsh settings shell, so the footer action is how the
 *   plugin gets a dashboard-style icon).
 *
 * The dashboard fetches aggregated usage and cost from the host routes and
 * renders summary cards, a per-day chart, per-model and per-session tables,
 * and a pricing/currency override editor. Costs convert between USD and CNY
 * with the configurable `fx.cnyPerUsd` rate; default display currency is USD.
 *
 * Plain React.createElement throughout - the module-loader factory format has
 * no build step (see @deepseek-ai/dsh-client-modules).
 */
window.__ModuleLoader__.load({
	id: "dsh-cost-dashboard",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		const { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } = react;
		const IconDataOutline16 = primitives.IconDataOutline16;

		const NS = "costDashboard";

		const zh = {
			nav: "费用看板",
			title: "费用看板",
			subtitle: "基于本机 dsh 会话日志的模型用量与费用统计",
			refresh: "刷新",
			auto: "每 15 秒自动刷新",
			"mode.tokens": "Tokens",
			"mode.cost": "费用",
			"card.totalCost": "总费用",
			"card.today": "今日费用",
			"card.input": "输入 tokens",
			"card.inputHint": "未命中缓存",
			"card.cacheRead": "缓存命中 tokens",
			"card.cacheWrite": "缓存写入 tokens",
			"card.output": "输出 tokens",
			"card.sessions": "会话数",
			"card.sessionsHint": "{n} 个有用量记录",
			unpriced: "未配置价格的模型（仅统计 tokens，不计费用）：{models}。可在下方价格配置中补充。",
			"chart.title": "每日趋势",
			"chart.window": "近 {n} 天",
			"chart.max": "峰值 {v}",
			"legend.input": "输入",
			"legend.cacheRead": "缓存命中",
			"legend.cacheWrite": "缓存写入",
			"legend.output": "输出",
			"table.models": "按模型汇总",
			"table.sessions": "按会话汇总",
			"table.sessionsHint": "显示前 {shown} / 共 {total} 条（按费用排序）",
			"col.model": "模型",
			"col.provider": "供应商",
			"col.input": "输入",
			"col.cacheRead": "缓存命中",
			"col.cacheWrite": "缓存写入",
			"col.output": "输出",
			"col.cost": "费用",
			"col.share": "占比",
			"col.tokens": "Tokens",
			"col.session": "会话",
			"col.project": "项目",
			"col.models": "模型",
			"col.time": "时间",
			subagent: "子代理",
			untitled: "（无标题）",
			multiModel: "· 共 {n} 个模型",
			"pricing.title": "价格配置",
			"pricing.hint": "保存到 ~/.dsh/cost-dashboard.json，按模型名整体覆盖内置价格。单位：每百万 tokens。字段：fx.cnyPerUsd（美元兑人民币，默认 6.79）；每个模型 currency (CNY|USD)、input、inputHit、cacheWrite、output；可选 peak {...} 与 peakHours [[9,12],[14,18]]（宿主本地时间，命中峰时改用 peak 费率，peak 未写的字段回落平价）。",
			"pricing.reload": "重新载入",
			"pricing.save": "保存",
			"pricing.saved": "已保存 ✓",
			"pricing.error": "保存失败：{msg}",
			"pricing.overridden": "（覆盖生效中）",
			"error.load": "加载失败：{msg}",
			empty: "还没有任何会话用量数据。",
			loading: "加载中…",
			"meta.files": "{n} 个日志文件",
			"meta.scanMs": "扫描 {n} ms",
			"meta.updated": "更新于 {time}",
			"meta.errors": "{n} 个文件读取失败",
			"meta.pricingErrors": "价格文件告警：{msg}",
		};

		const en = {
			nav: "Cost Dashboard",
			title: "Cost Dashboard",
			subtitle: "Model usage and spend across local dsh session logs",
			refresh: "Refresh",
			auto: "Auto-refreshes every 15s",
			"mode.tokens": "Tokens",
			"mode.cost": "Cost",
			"card.totalCost": "Total cost",
			"card.today": "Today",
			"card.input": "Input tokens",
			"card.inputHint": "cache miss",
			"card.cacheRead": "Cache read tokens",
			"card.cacheWrite": "Cache write tokens",
			"card.output": "Output tokens",
			"card.sessions": "Sessions",
			"card.sessionsHint": "{n} with usage",
			unpriced: "Models without pricing (tokens counted, cost not): {models}. Add them in the pricing config below.",
			"chart.title": "Daily trend",
			"chart.window": "last {n} days",
			"chart.max": "peak {v}",
			"legend.input": "input",
			"legend.cacheRead": "cache read",
			"legend.cacheWrite": "cache write",
			"legend.output": "output",
			"table.models": "By model",
			"table.sessions": "By session",
			"table.sessionsHint": "showing {shown} of {total} rows (by cost)",
			"col.model": "Model",
			"col.provider": "Provider",
			"col.input": "Input",
			"col.cacheRead": "Cache read",
			"col.cacheWrite": "Cache write",
			"col.output": "Output",
			"col.cost": "Cost",
			"col.share": "Share",
			"col.tokens": "Tokens",
			"col.session": "Session",
			"col.project": "Project",
			"col.models": "Models",
			"col.time": "When",
			subagent: "subagent",
			untitled: "(untitled)",
			multiModel: "· {n} models",
			"pricing.title": "Pricing config",
			"pricing.hint": "Saves to ~/.dsh/cost-dashboard.json; each model entry wholly overrides the builtin one. Rates per 1M tokens. Fields: fx.cnyPerUsd (USD->CNY, default 6.79); per model currency (CNY|USD), input, inputHit, cacheWrite, output; optional peak {...} and peakHours [[9,12],[14,18]] (host-local clock; peak hours use peak rates, unset peak fields fall back to flat).",
			"pricing.reload": "Reload",
			"pricing.save": "Save",
			"pricing.saved": "Saved ✓",
			"pricing.error": "Save failed: {msg}",
			"pricing.overridden": "(overrides active)",
			"error.load": "Load failed: {msg}",
			empty: "No session usage yet.",
			loading: "Loading…",
			"meta.files": "{n} log files",
			"meta.scanMs": "scanned in {n} ms",
			"meta.updated": "updated {time}",
			"meta.errors": "{n} files failed to read",
			"meta.pricingErrors": "pricing file warning: {msg}",
		};

		const CSS = `
.cd-root{display:flex;flex-direction:column;gap:16px;font-size:13px}
.cd-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.cd-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.cd-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:1 1 auto;min-width:200px}
.cd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cd-toggle{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.cd-toggle button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 12px;font-size:12px;cursor:pointer}
.cd-toggle button.cd-on{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.cd-refresh{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer}
.cd-refresh:hover{color:var(--dsw-alias-label-primary)}
.cd-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px}
.cd-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.cd-cardLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.cd-cardValue{color:var(--dsw-alias-label-primary);font-size:17px;line-height:22px;font-variant-numeric:tabular-nums;word-break:break-all}
.cd-cardHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px}
.cd-error{border:1px solid #b91c1c55;border-radius:10px;background:#b91c1c14;color:#b91c1c;padding:8px 12px}
.cd-notice{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary);padding:8px 12px;font-size:12px}
.cd-sectionTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.cd-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:4px}
.cd-legendItem{display:inline-flex;align-items:center;gap:5px}
.cd-dot{width:8px;height:8px;border-radius:2px;display:inline-block}
.cd-tableWrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.cd-table{width:100%;border-collapse:collapse;font-size:12.5px}
.cd-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:left;padding:7px 10px;white-space:nowrap;font-size:11.5px}
.cd-table td{padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);vertical-align:top}
.cd-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.cd-mono{font-family:var(--dsw-font-mono)}
.cd-dim{color:var(--dsw-alias-label-tertiary)}
.cd-badge{display:inline-block;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);border-radius:5px;padding:0 6px;font-size:10.5px;line-height:17px;margin-right:4px;white-space:nowrap}
.cd-share{position:relative;background:var(--dsw-alias-fill-l1);border-radius:4px;height:6px;min-width:60px;overflow:hidden}
.cd-shareFill{position:absolute;inset:0 auto 0 0;background:#4e83ff66}
.cd-chart{display:flex;flex-direction:column;gap:6px}
.cd-chartRow{display:flex;align-items:center;gap:8px}
.cd-chartLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:64px;font-variant-numeric:tabular-nums}
.cd-svg{width:100%;height:120px;display:block}
.cd-details{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0}
.cd-details>summary{cursor:pointer;padding:10px 12px;color:var(--dsw-alias-label-secondary);font-size:12.5px;list-style:none}
.cd-details>summary::before{content:"▸ ";color:var(--dsw-alias-label-tertiary)}
.cd-details[open]>summary::before{content:"▾ "}
.cd-editor{padding:0 12px 12px;display:flex;flex-direction:column;gap:8px}
.cd-editor textarea{width:100%;min-height:220px;box-sizing:border-box;font-family:var(--dsw-font-mono);font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:8px;resize:vertical}
.cd-editorRow{display:flex;align-items:center;gap:8px}
.cd-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer}
.cd-btn:hover{color:var(--dsw-alias-label-primary)}
.cd-btnPrimary{border-color:#4e83ff;color:#4e83ff}
.cd-saved{color:#23a55a;font-size:12px}
.cd-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;display:flex;gap:12px;flex-wrap:wrap}
.cd-empty{color:var(--dsw-alias-label-tertiary);padding:24px 0;text-align:center}
.cd-chartCard{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px}
.cd-footer{position:relative}
.cd-footerBtn{box-sizing:border-box;cursor:pointer;width:100%;height:36px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 8px;font-size:12.5px;line-height:18px;display:flex}
.cd-footerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cd-footerBtnOpen{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cd-footerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cd-footerMask{position:fixed;inset:0;z-index:998;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32))}
.cd-footerPanel{position:fixed;z-index:999;box-sizing:border-box;width:760px;max-width:calc(100vw - 32px);max-height:min(720px,calc(100vh - 120px));background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:var(--dsw-shadow-lv3);display:flex;flex-direction:column;overflow:hidden}
.cd-footerPanelHead{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.cd-footerPanelTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.cd-footerClose{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:28px;font-size:16px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.cd-footerClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cd-footerPanelBody{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}
`;

		const TAG = "dsh-cost-dashboard/styles.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cost-dashboard";
			tag.dataset.pluginCss = TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const COLORS = { input: "#4e83ff", cacheRead: "#23a55a", cacheWrite: "#f5a623", output: "#9d7bd8" };
		const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$" };
		const DEFAULT_CNY_PER_USD = 6.79;

		function fmtTokens(value) {
			if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
			if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
			return String(value);
		}

		function fmtCost(currency, amount) {
			const symbol = CURRENCY_SYMBOLS[currency] ?? "";
			const abs = Math.abs(amount);
			if (abs === 0) return `${symbol}0.00`;
			if (abs < 0.01) return `${symbol}${amount.toFixed(4)}`;
			if (abs >= 10000) return symbol + Math.round(amount).toLocaleString();
			return `${symbol}${amount.toFixed(2)}`;
		}

		function fmtWhen(time) {
			if (!time) return "—";
			const date = new Date(time);
			return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}

		function el(tag, props, ...children) {
			return h(tag, props ?? {}, ...children);
		}

		/** Convert a {CNY,USD} cost map into one number in the target currency. */
		function inCurrency(byCurrency, currency, cnyPerUsd) {
			const cny = byCurrency?.CNY ?? 0;
			const usd = byCurrency?.USD ?? 0;
			if (currency === "CNY") return cny + usd * cnyPerUsd;
			return usd + cny / cnyPerUsd;
		}

		/** Stacked daily tokens chart (viewBox-scaled SVG, no dependencies). */
		function TokensChart({ days, t }) {
			if (days.length === 0) return null;
			const slot = Math.max(10, Math.min(26, Math.floor(900 / days.length)));
			const width = days.length * slot;
			const height = 120;
			const padTop = 6;
			const max = Math.max(1, ...days.map((day) => day.input + day.cacheRead + day.cacheWrite + day.output));
			const scale = (value) => (height - padTop) * (value / max);
			const bars = [];
			days.forEach((day, index) => {
				const x = index * slot;
				const parts = [
					["input", day.input, COLORS.input],
					["cacheRead", day.cacheRead, COLORS.cacheRead],
					["cacheWrite", day.cacheWrite, COLORS.cacheWrite],
					["output", day.output, COLORS.output],
				];
				let y = height;
				for (const [key, value, color] of parts) {
					if (value <= 0) continue;
					const barHeight = scale(value);
					y -= barHeight;
					bars.push(el("rect", {
						key: `${index}-${key}`,
						x: x + 1.5,
						y,
						width: slot - 3,
						height: Math.max(0, barHeight),
						fill: color,
						rx: key === "output" || y + barHeight >= height ? 1.5 : 0,
					}));
				}
				const total = day.input + day.cacheRead + day.cacheWrite + day.output;
				bars.push(el("title", { key: `t-${index}` }, `${day.date} · ${t("legend.input")} ${fmtTokens(day.input)} · ${t("legend.cacheRead")} ${fmtTokens(day.cacheRead)} · ${t("legend.cacheWrite")} ${fmtTokens(day.cacheWrite)} · ${t("legend.output")} ${fmtTokens(day.output)} · Σ ${fmtTokens(total)}`));
				bars.push(el("rect", { key: `h-${index}`, x: x, y: 0, width: slot, height, fill: "transparent" }, el("title", {}, day.date)));
			});
			const labelStep = Math.max(1, Math.ceil(days.length / 12));
			return el("svg", { className: "cd-svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" },
				el("line", { x1: 0, y1: height - 0.5, x2: width, y2: height - 0.5, stroke: "var(--dsw-alias-border-l2, #ddd)" }),
				bars,
				days.map((day, index) => index % labelStep === 0
					? el("text", { key: `x-${index}`, x: index * slot + slot / 2, y: height - 2, fontSize: 8, fill: "var(--dsw-alias-label-tertiary, #999)", textAnchor: "middle" }, day.date.slice(5))
					: null));
		}

		/** Single-series daily cost chart in the selected currency. */
		function CostChart({ days, currency, cnyPerUsd, t }) {
			if (days.length === 0) return null;
			const slot = Math.max(10, Math.min(26, Math.floor(900 / days.length)));
			const width = days.length * slot;
			const height = 96;
			const max = Math.max(0.000001, ...days.map((day) => inCurrency(day.costByCurrency, currency, cnyPerUsd)));
			const bars = days.map((day, index) => {
				const amount = inCurrency(day.costByCurrency, currency, cnyPerUsd);
				if (amount <= 0) return null;
				const barHeight = (height - 4) * (amount / max);
				return el("rect", {
					key: index,
					x: index * slot + 1.5,
					y: height - barHeight,
					width: slot - 3,
					height: barHeight,
					fill: COLORS.input,
					rx: 1.5,
				}, el("title", {}, `${day.date} · ${fmtCost(currency, amount)}`));
			});
			const labelStep = Math.max(1, Math.ceil(days.length / 12));
			return el("div", { className: "cd-chart" },
				el("div", { className: "cd-chartRow" },
					el("span", { className: "cd-chartLabel" }, `${CURRENCY_SYMBOLS[currency] ?? currency} · ${t("chart.max", { v: fmtCost(currency, max) })}`)),
				el("svg", { className: "cd-svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", style: { height: 96 } },
					el("line", { x1: 0, y1: height - 0.5, x2: width, y2: height - 0.5, stroke: "var(--dsw-alias-border-l2, #ddd)" }),
					bars,
					days.map((day, index) => index % labelStep === 0
						? el("text", { key: `x-${index}`, x: index * slot + slot / 2, y: height - 2, fontSize: 8, fill: "var(--dsw-alias-label-tertiary, #999)", textAnchor: "middle" }, day.date.slice(5))
						: null)));
		}

		function Card({ label, value, hint }) {
			return el("div", { className: "cd-card" },
				el("div", { className: "cd-cardLabel" }, label),
				el("div", { className: "cd-cardValue" }, value),
				hint ? el("div", { className: "cd-cardHint" }, hint) : null);
		}

		function Dashboard(props) {
			const t = props.t;
			const [data, setData] = useState(null);
			const [error, setError] = useState(null);
			const [loading, setLoading] = useState(true);
			const [mode, setMode] = useState("cost");
			const [currency, setCurrency] = useState("USD");
			const [editorOpen, setEditorOpen] = useState(false);
			const [editorText, setEditorText] = useState("");
			const [editorStatus, setEditorStatus] = useState(null);
			const alive = useRef(true);

			const fx = data?.fx?.cnyPerUsd ?? DEFAULT_CNY_PER_USD;

			const load = useCallback(async () => {
				try {
					const response = await fetch("/cost-dashboard/stats", { cache: "no-store" });
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					if (!alive.current) return;
					setData(payload);
					setError(null);
				} catch (caught) {
					if (!alive.current) return;
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					if (alive.current) setLoading(false);
				}
			}, []);

			useEffect(() => {
				alive.current = true;
				load();
				const timer = setInterval(load, 15000);
				return () => {
					alive.current = false;
					clearInterval(timer);
				};
			}, [load]);

			const loadPricing = useCallback(async () => {
				const response = await fetch("/cost-dashboard/pricing", { cache: "no-store" });
				const payload = await response.json();
				if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
				const base = payload.override?.models ?? payload.builtin.models;
				setEditorText(JSON.stringify({ fx: payload.fx ?? { cnyPerUsd: DEFAULT_CNY_PER_USD }, models: base }, null, 2));
				setEditorStatus(payload.override ? { kind: "hint", text: t("pricing.overridden") } : null);
			}, [t]);

			const savePricing = useCallback(async () => {
				setEditorStatus({ kind: "busy" });
				try {
					const response = await fetch("/cost-dashboard/pricing", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ content: editorText }),
					});
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					setEditorStatus({ kind: "ok", text: t("pricing.saved") });
					load();
				} catch (caught) {
					setEditorStatus({ kind: "error", text: t("pricing.error", { msg: caught instanceof Error ? caught.message : String(caught) }) });
				}
			}, [editorText, load, t]);

			const summary = data?.summary;
			const chartDays = useMemo(() => (data?.byDay ?? []).slice(-30), [data]);
			const totalTokens = summary
				? summary.totals.input + summary.totals.cacheRead + summary.totals.cacheWrite + summary.totals.output
				: 0;
			const totalCost = summary ? inCurrency(summary.costByCurrency, currency, fx) : 0;
			const todayCost = summary ? inCurrency(summary.todayCostByCurrency, currency, fx) : 0;

			if (loading && data === null) return el("div", { className: "cd-root" }, el("div", { className: "cd-empty" }, t("loading")));
			if (error !== null && data === null) return el("div", { className: "cd-root" }, el("div", { className: "cd-error" }, t("error.load", { msg: error })));

			return el("div", { className: "cd-root" },
				el("div", { className: "cd-head" },
					el("span", { className: "cd-title" }, t("title")),
					el("span", { className: "cd-sub" }, `${t("subtitle")} · ${t("auto")}`),
					el("div", { className: "cd-actions" },
						el("div", { className: "cd-toggle" },
							el("button", { className: mode === "cost" ? "cd-on" : "", onClick: () => setMode("cost") }, t("mode.cost")),
							el("button", { className: mode === "tokens" ? "cd-on" : "", onClick: () => setMode("tokens") }, t("mode.tokens"))),
						el("div", { className: "cd-toggle" },
							el("button", { className: currency === "USD" ? "cd-on" : "", onClick: () => setCurrency("USD") }, "USD"),
							el("button", { className: currency === "CNY" ? "cd-on" : "", onClick: () => setCurrency("CNY") }, "CNY")),
						el("button", { className: "cd-refresh", onClick: () => { setLoading(true); load(); } }, t("refresh")))),
				error !== null ? el("div", { className: "cd-error" }, t("error.load", { msg: error })) : null,
				data === null || summary === null || summary.sessions === 0 ? el("div", { className: "cd-empty" }, t("empty")) : el(react.Fragment, null,
					el("div", { className: "cd-cards" },
						el(Card, { label: t("card.totalCost"), value: fmtCost(currency, totalCost), hint: `${t("card.today")}: ${fmtCost(currency, todayCost)}` }),
						el(Card, { label: t("card.input"), value: fmtTokens(summary.totals.input), hint: t("card.inputHint") }),
						el(Card, { label: t("card.cacheRead"), value: fmtTokens(summary.totals.cacheRead) }),
						el(Card, { label: t("card.cacheWrite"), value: fmtTokens(summary.totals.cacheWrite) }),
						el(Card, { label: t("card.output"), value: fmtTokens(summary.totals.output) }),
						el(Card, { label: t("card.sessions"), value: String(summary.sessions), hint: t("card.sessionsHint", { n: summary.activeSessions }) })),
					data.unpricedModels.length > 0 ? el("div", { className: "cd-notice" }, t("unpriced", { models: data.unpricedModels.join(", ") })) : null,
					el("div", { className: "cd-chartCard" },
						el("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 } },
							el("span", { className: "cd-sectionTitle" }, t("chart.title")),
							el("span", { className: "cd-dim", style: { fontSize: 11 } }, t("chart.window", { n: chartDays.length }))),
						mode === "tokens"
							? el("div", { className: "cd-chart" },
								el(TokensChart, { days: chartDays, t }),
								el("div", { className: "cd-legend" },
									el("span", { className: "cd-legendItem" }, el("span", { className: "cd-dot", style: { background: COLORS.input } }), t("legend.input")),
									el("span", { className: "cd-legendItem" }, el("span", { className: "cd-dot", style: { background: COLORS.cacheRead } }), t("legend.cacheRead")),
									el("span", { className: "cd-legendItem" }, el("span", { className: "cd-dot", style: { background: COLORS.cacheWrite } }), t("legend.cacheWrite")),
									el("span", { className: "cd-legendItem" }, el("span", { className: "cd-dot", style: { background: COLORS.output } }), t("legend.output"))))
							: el(CostChart, { days: chartDays, currency, cnyPerUsd: fx, t })),
					el("div", null,
						el("div", { className: "cd-sectionTitle", style: { margin: "4px 0 8px" } }, t("table.models")),
						el("div", { className: "cd-tableWrap" },
							el("table", { className: "cd-table" },
								el("thead", null, el("tr", null,
									el("th", null, t("col.model")),
									el("th", { className: "cd-num" }, t("col.input")),
									el("th", { className: "cd-num" }, t("col.cacheRead")),
									el("th", { className: "cd-num" }, t("col.output")),
									el("th", { className: "cd-num" }, t("col.cost")),
									el("th", null, t("col.share")))),
								el("tbody", null, data.byModel.map((row) => {
									const tokens = row.input + row.cacheRead + row.cacheWrite + row.output;
									const share = totalTokens > 0 ? tokens / totalTokens : 0;
									return el("tr", { key: `${row.provider}/${row.model}` },
										el("td", null,
											el("span", { className: "cd-mono" }, row.model ?? "—"),
											el("div", { className: "cd-dim", style: { fontSize: 11 } }, row.provider ?? "")),
										el("td", { className: "cd-num", title: String(row.input) }, fmtTokens(row.input)),
										el("td", { className: "cd-num", title: String(row.cacheRead) }, fmtTokens(row.cacheRead)),
										el("td", { className: "cd-num", title: String(row.output) }, fmtTokens(row.output)),
										el("td", { className: "cd-num" }, row.priced ? fmtCost(currency, inCurrency(row.costByCurrency, currency, fx)) : "—"),
										el("td", null, el("div", { className: "cd-share", title: `${(share * 100).toFixed(1)}%` }, el("div", { className: "cd-shareFill", style: { width: `${Math.round(share * 100)}%` } }))));
								}))))),
					el("div", null,
						el("div", { style: { display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0 8px" } },
							el("span", { className: "cd-sectionTitle" }, t("table.sessions")),
							el("span", { className: "cd-dim", style: { fontSize: 11 } }, t("table.sessionsHint", { shown: data.bySession.length, total: data.sessionCount }))),
						el("div", { className: "cd-tableWrap" },
							el("table", { className: "cd-table" },
								el("thead", null, el("tr", null,
									el("th", null, t("col.session")),
									el("th", null, t("col.model")),
									el("th", { className: "cd-num" }, t("col.tokens")),
									el("th", { className: "cd-num" }, t("col.cost")),
									el("th", null, t("col.time")))),
								el("tbody", null, data.bySession.map((row, index) => el("tr", { key: `${row.sessionId}-${row.provider}-${row.model}-${index}` },
									el("td", null,
										el("div", { style: { maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title ?? t("untitled")),
										el("div", { className: "cd-dim", style: { fontSize: 11 } },
											row.isSubagent ? el("span", { className: "cd-badge" }, t("subagent")) : null,
											row.project ?? "",
											row.modelsTotal > 1 ? ` ${t("multiModel", { n: row.modelsTotal })}` : "")),
									el("td", null, el("span", { className: "cd-badge cd-mono" }, row.model ?? "?")),
									el("td", { className: "cd-num", title: `in ${row.input} / cr ${row.cacheRead} / out ${row.output}` }, fmtTokens(row.input + row.cacheRead + row.cacheWrite + row.output)),
									el("td", { className: "cd-num" }, fmtCost(currency, inCurrency(row.costByCurrency, currency, fx))),
									el("td", { className: "cd-dim", style: { whiteSpace: "nowrap" } }, fmtWhen(row.lastTime || row.createdAt))))))))),
				el("details", { className: "cd-details", open: editorOpen, onToggle: (event) => {
					setEditorOpen(event.currentTarget.open);
					if (event.currentTarget.open && editorText === "") loadPricing().catch((caught) => setEditorStatus({ kind: "error", text: String(caught) }));
				} },
					el("summary", null, t("pricing.title")),
					el("div", { className: "cd-editor" },
						el("div", { className: "cd-dim", style: { fontSize: 11.5 } }, t("pricing.hint")),
						el("textarea", { spellCheck: false, value: editorText, onChange: (event) => setEditorText(event.target.value) }),
						el("div", { className: "cd-editorRow" },
							el("button", { className: "cd-btn cd-btnPrimary", disabled: editorStatus?.kind === "busy", onClick: savePricing }, t("pricing.save")),
							el("button", { className: "cd-btn", onClick: () => loadPricing().catch((caught) => setEditorStatus({ kind: "error", text: String(caught) })) }, t("pricing.reload")),
							editorStatus?.text ? el("span", { className: editorStatus.kind === "error" ? "cd-error" : "cd-saved", style: { padding: "2px 6px" } }, editorStatus.text) : null))),
				el("div", { className: "cd-meta" },
					data?.meta ? el("span", null, t("meta.files", { n: data.meta.files })) : null,
					data?.meta ? el("span", null, t("meta.scanMs", { n: data.meta.scanMs })) : null,
					data?.meta ? el("span", null, t("meta.updated", { time: fmtWhen(data.meta.generatedAt) })) : null,
					data?.meta?.errors?.length ? el("span", { title: data.meta.errors.join("\n") }, t("meta.errors", { n: data.meta.errors.length })) : null,
					data?.pricingErrors?.length ? el("span", { title: data.pricingErrors.join("\n") }, t("meta.pricingErrors", { msg: data.pricingErrors[0] })) : null));
		}

		/** Sidebar footer action: dashboard icon + anchored panel with the dashboard. */
		function FooterAction({ wide, t }) {
			const [open, setOpen] = useState(false);
			const [anchor, setAnchor] = useState(null);
			const rootRef = useRef(null);
			useLayoutEffect(() => {
				if (!open) return;
				const place = () => {
					const rect = rootRef.current?.getBoundingClientRect();
					if (rect !== undefined) {
						setAnchor({
							left: Math.max(8, Math.min(rect.left, window.innerWidth - 776)),
							bottom: Math.max(8, window.innerHeight - rect.top + 8),
						});
					}
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);
			useEffect(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);
			return el("div", { className: "cd-footer", ref: rootRef },
				el("button", {
					type: "button",
					className: `cd-footerBtn${open ? " cd-footerBtnOpen" : ""}`,
					title: t("nav"),
					"aria-expanded": open ? "true" : "false",
					onClick: () => setOpen((value) => !value),
				},
					el(IconDataOutline16, { size: 16 }),
					wide ? el("span", { className: "cd-footerLabel" }, t("nav")) : null),
				open ? el("div", { className: "cd-footerMask", onClick: () => setOpen(false) }) : null,
				open ? el("div", { className: "cd-footerPanel", style: anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined },
					el("div", { className: "cd-footerPanelHead" },
						el("span", { className: "cd-footerPanelTitle" }, t("title")),
						el("button", { className: "cd-footerClose", title: "Close", onClick: () => setOpen(false) }, "×")),
					el("div", { className: "cd-footerPanelBody" }, el(Dashboard, { t }))) : null);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "cost-dashboard: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "cost-dashboard",
				order: 45,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t }),
			}, Dashboard));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "cost-dashboard",
				locale: NS,
				inject: () => ({ t }),
			}, FooterAction));
		}

		exports.name = "cost-dashboard";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});

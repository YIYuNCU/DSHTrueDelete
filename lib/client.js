/**
 * dsh-true-delete —— 页面端（浏览器半边）
 *
 * 它只做两件事：
 *  1. 往 `sidebar.workspaces.session.menu.item` 这个插槽里加一行「删除本地文件…」，
 *     并且只在「已归档」的行上出现（红框里那个菜单的第四个位置）；
 *  2. 往 `shell.overlay` 里加一个确认框：先向宿主问清这次到底会删哪些文件、多大，
 *     列出来，用户点确认才真的删；删完弹一个 Toast。
 *
 * 这个文件不经过打包器：DSH 的客户端模块加载器直接吃 `window.__ModuleLoader__.load`，
 * 只要用到的模块都在平台种子表里（react / react-dom / jsx-runtime / client-store /
 * ui-slots / ui-primitives 都在），就不需要任何构建步骤。
 */
window.__ModuleLoader__.load({
	id: "dsh-true-delete",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		const react = require("react")
		const react_jsx_runtime = require("react/jsx-runtime")
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives")
		const client_store = require("@deepseek-ai/dsh-client-store")

		/** 本插件拥有的词典命名空间。 */
		const NS = "archiveCleaner"

		const zh = {
			"menu.delete": "删除本地文件…",
			"confirm.title": "删除已归档会话的本地文件",
			"confirm.desc": "将从这台电脑上删除「{title}」的会话日志与投影缓存。此操作不可撤销。",
			"confirm.empty": "没有找到属于该会话的本地文件（可能已经被清理过）。",
			"confirm.files": "将删除以下内容：",
			"confirm.total": "共 {count} 个文件，{size}",
			"confirm.children": "其中包含 {count} 个子代理会话（它们不会出现在侧边栏里）。",
			"confirm.active": "该会话还有正在运行的工作（{kinds}），已禁止删除；请先停止它。",
			"role.session": "会话日志",
			"role.child": "子会话",
			"role.cache": "投影缓存",
			"confirm.action": "永久删除",
			"confirm.pending": "正在删除…",
			"confirm.loading": "正在统计本地文件…",
			"cancel": "取消",
			"close": "关闭",
			"done.title": "已删除",
			"done.text": "已删除「{title}」的本地文件（{count} 个文件，{size}）。",
			"error.title": "删除失败",
			"error.generic": "操作失败：{message}",
		}
		const en = {
			"menu.delete": "Delete local files…",
			"confirm.title": "Delete an archived session's local files",
			"confirm.desc": "This removes “{title}”'s transcript and projection cache from this computer. It cannot be undone.",
			"confirm.empty": "No local file belongs to this session (it may already be clean).",
			"confirm.files": "The following will be deleted:",
			"confirm.total": "{count} files, {size}",
			"confirm.children": "Including {count} subagent sessions (they never appear in the sidebar).",
			"confirm.active": "This session still has running work ({kinds}); deleting is blocked until it stops.",
			"role.session": "Transcript",
			"role.child": "Sub-session",
			"role.cache": "Projection cache",
			"confirm.action": "Delete permanently",
			"confirm.pending": "Deleting…",
			"confirm.loading": "Measuring local files…",
			"cancel": "Cancel",
			"close": "Close",
			"done.title": "Deleted",
			"done.text": "Deleted “{title}”'s local files ({count} files, {size}).",
			"error.title": "Delete failed",
			"error.generic": "Operation failed: {message}",
		}

		//#region 宿主调用

		/**
		 * 路由地址按文档相对地址解析：桌面端的页面挂在 dsh-app://app/ 上，
		 * 这个协议会把非静态资源转发给本机 webServer；反代/带路径前缀的部署下
		 * 也不会把请求打到根上。**必须带上 query**（sessionId 就在 query 里）。
		 */
		function routePath(relative) {
			try {
				const url = new URL(relative, document.baseURI)
				return url.pathname + url.search
			} catch (error) {
				return relative
			}
		}

		/** 调用宿主端路由；失败统一抛带可读信息的 Error。 */
		async function callHost(relative, init) {
			const response = await fetch(routePath(relative), {
				credentials: "same-origin",
				...init,
			})
			let payload
			try {
				payload = await response.json()
			} catch (error) {
				throw new Error(`HTTP ${String(response.status)}`)
			}
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				const message = payload && payload.error && payload.error.message
				throw new Error(message || `HTTP ${String(response.status)}`)
			}
			return payload.value
		}

		const statusOf = (sessionId) =>
			callHost(`/dsh-true-delete/status?sessionId=${encodeURIComponent(sessionId)}`)

		const deleteSession = (sessionId) =>
			callHost("/dsh-true-delete/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId }),
			})

		//#endregion

		//#region 工具

		/** 人类可读的字节数。 */
		function sizeText(bytes) {
			const value = Number(bytes) || 0
			if (value < 1024) return `${String(value)} B`
			const units = ["KB", "MB", "GB", "TB"]
			let scaled = value / 1024
			let index = 0
			while (scaled >= 1024 && index < units.length - 1) {
				scaled /= 1024
				index += 1
			}
			return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[index]}`
		}

		/**
		 * 把「归档集合」投影成一个稳定的快照源。
		 * useSyncExternalStore 要求 getSnapshot 在数据没变时返回同一个引用，
		 * 所以这里按源快照的身份做记忆化，不能每次新建 Set。
		 */
		function derive(source, project) {
			let seen
			let value
			return {
				getSnapshot: () => {
					const snapshot = source.getSnapshot()
					if (value === undefined || snapshot !== seen) {
						seen = snapshot
						value = project(snapshot)
					}
					return value
				},
				subscribe: (listener) => source.subscribe(listener),
			}
		}

		const EMPTY_SET = new Set()
		const EMPTY_SNAPSHOT = { archivedSessionIds: [] }

		//#endregion

		//#region 菜单项：只对已归档的行出现

		/**
		 * 菜单行：删除本地文件。
		 * 复用插槽声明的 `useMenuOpenState`（点了要先把菜单关掉），
		 * 归档状态来自 workspaces 客户端的归档集合。
		 */
		function DeleteArchivedMenuItem({
			sessionId,
			displayTitle,
			useArchived,
			useMenuOpenState,
			requestDelete,
			t,
		}) {
			const [, setMenuOpen] = useMenuOpenState()
			const archived = useArchived((set) => set.has(sessionId))
			if (archived !== true) return null
			return react_jsx_runtime.jsx(primitives.MenuItemButton, {
				danger: true,
				icon: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false)
					requestDelete(sessionId, displayTitle)
				},
				children: t("menu.delete"),
			})
		}

		//#endregion

		//#region 确认框

		/**
		 * 覆盖层：确认框 + 结果 Toast。
		 * 请求状态放在 root 作用域的 store 里，这样菜单一关（菜单项被卸载）对话框还在。
		 */
		function ArchiveCleanerOverlay({ useRequest, settle, refreshSessions, t }) {
			const request = useRequest((value) => value)
			const [phase, setPhase] = react.useState("loading")
			const [plan, setPlan] = react.useState(null)
			const [error, setError] = react.useState(null)
			const [toast, setToast] = react.useState(null)

			const sessionId = request === null ? null : request.sessionId

			react.useEffect(() => {
				if (sessionId === null) return undefined
				let cancelled = false
				setPhase("loading")
				setPlan(null)
				setError(null)
				statusOf(sessionId)
					.then((value) => {
						if (cancelled) return
						setPlan(value)
						setPhase("confirm")
					})
					.catch((reason) => {
						if (cancelled) return
						setError(String((reason && reason.message) || reason))
						setPhase("error")
					})
				return () => {
					cancelled = true
				}
			}, [sessionId])

			if (request === null) {
				return toast === null
					? null
					: react_jsx_runtime.jsx(primitives.Toast, {
							text: toast,
							onDone: () => {
								setToast(null)
							},
						})
			}

			const title = request.displayTitle || request.sessionId
			const close = () => {
				if (phase === "busy") return
				settle()
			}
			const confirm = () => {
				setPhase("busy")
				deleteSession(request.sessionId)
					.then((result) => {
						const count =
							(Array.isArray(result.removed) ? result.removed.length : 0) +
							(Array.isArray(result.swept) ? result.swept.length : 0)
						setToast(t("done.text", { title, count: String(count), size: sizeText(result.bytes) }))
						settle()
						// 文件没了、注册表也摘干净了，让会话列表重新向宿主拉一次，
						// 那一行才会真的从侧边栏消失（而不是等到下次重启）。
						refreshSessions()
					})
					.catch((reason) => {
						setError(String((reason && reason.message) || reason))
						setPhase("error")
					})
			}

			const files = plan !== null && Array.isArray(plan.items) ? plan.items : []
			const fileCount = files.reduce(
				(total, item) => total + (Array.isArray(item.files) ? item.files.length : 0),
				0,
			)
			const totalBytes = plan !== null && typeof plan.totalBytes === "number" ? plan.totalBytes : 0

			const body = []
			if (phase === "loading") {
				body.push(
					react_jsx_runtime.jsx(
						"div",
						{ className: "dsh-true-delete__status", role: "status", children: t("confirm.loading") },
						"loading",
					),
				)
			}
			if (files.length === 0 && phase === "confirm") {
				body.push(
					react_jsx_runtime.jsx("div", { className: "dsh-true-delete__empty", children: t("confirm.empty") }, "empty"),
				)
			} else if (files.length > 0) {
				body.push(
					react_jsx_runtime.jsx("div", { className: "dsh-true-delete__label", children: t("confirm.files") }, "label"),
					react_jsx_runtime.jsx(
						"ul",
						{
							className: "dsh-true-delete__list",
							children: files.map((item) =>
								react_jsx_runtime.jsx(
									"li",
									{
										className: "dsh-true-delete__item",
										children: [
											react_jsx_runtime.jsx(
												"span",
												{
													className: `dsh-true-delete__role dsh-true-delete__role--${String(item.role ?? "cache")}`,
													children: t(`role.${String(item.role ?? "cache")}`),
												},
												`role:${item.path}`,
											),
											react_jsx_runtime.jsx(
												"code",
												{ className: "dsh-true-delete__path", title: item.path, children: item.path },
												`path:${item.path}`,
											),
											react_jsx_runtime.jsx(
												"span",
												{
													className: "dsh-true-delete__size",
													children: sizeText(item.bytes),
												},
												`size:${item.path}`,
											),
										],
									},
									item.path,
								),
							),
						},
						"list",
					),
					react_jsx_runtime.jsx(
						"div",
						{
							className: "dsh-true-delete__total",
							children: t("confirm.total", { count: String(fileCount), size: sizeText(totalBytes) }),
						},
						"total",
					),
					Array.isArray(plan.children) && plan.children.length > 0
						? react_jsx_runtime.jsx(
								"div",
								{
									className: "dsh-true-delete__total",
									children: t("confirm.children", { count: String(plan.children.length) }),
								},
								"children",
							)
						: null,
				)
			}
			if (phase === "busy") {
				body.push(
					react_jsx_runtime.jsx(
						"div",
						{ className: "dsh-true-delete__status", role: "status", children: t("confirm.pending") },
						"pending",
					),
				)
			}
			const activeKinds = plan !== null && Array.isArray(plan.activity) ? plan.activity : []
			if (activeKinds.length > 0) {
				body.push(
					react_jsx_runtime.jsx(
						"div",
						{
							className: "dsh-true-delete__error",
							role: "alert",
							children: t("confirm.active", { kinds: activeKinds.join(", ") }),
						},
						"active",
					),
				)
			}
			if (error !== null) {
				body.push(
					react_jsx_runtime.jsx(
						"div",
						{ className: "dsh-true-delete__error", role: "alert", children: t("error.generic", { message: error }) },
						"error",
					),
				)
			}

			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsx(primitives.Modal, {
						open: true,
						onClose: close,
						closeLabel: t("close"),
						title: t("confirm.title"),
						description: t("confirm.desc", { title }),
						footer: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
							children: [
								react_jsx_runtime.jsx(primitives.Button, {
									variant: "outline",
									disabled: phase === "busy",
									onClick: close,
									children: t("cancel"),
								}),
								react_jsx_runtime.jsx(primitives.Button, {
									variant: "outline",
									className: "dsh-true-delete__danger",
									disabled: phase === "busy" || phase === "loading" || activeKinds.length > 0,
									onClick: confirm,
									children: t("confirm.action"),
								}),
							],
						}),
						children: body,
					}),
					toast === null
						? null
						: react_jsx_runtime.jsx(primitives.Toast, {
								text: toast,
								onDone: () => {
									setToast(null)
								},
							}),
				],
			})
		}

		//#endregion

		//#region 样式（直接注入，跟着插件一起被移除）

		const CSS = `
.dsh-true-delete__label{margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-true-delete__list{margin:0 0 10px;padding:0;list-style:none;max-height:240px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.dsh-true-delete__item{display:flex;gap:10px;align-items:baseline;justify-content:space-between;padding:6px 10px;font-size:12px}
.dsh-true-delete__role{flex:none;border-radius:4px;padding:1px 6px;font-size:11px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary)}
.dsh-true-delete__role--child{opacity:.85}
.dsh-true-delete__item+.dsh-true-delete__item{border-top:1px solid var(--dsw-alias-border-l3)}
.dsh-true-delete__path{flex:1;min-width:0;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);word-break:break-all;color:var(--dsw-alias-label-primary)}
.dsh-true-delete__size{flex:none;color:var(--dsw-alias-label-secondary)}
.dsh-true-delete__total{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-true-delete__status{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-true-delete__empty{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-true-delete__error{margin-top:8px;color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;word-break:break-word}
.dsh-true-delete__danger{color:var(--dsw-alias-state-error-primary,#d33)!important;border-color:var(--dsw-alias-state-error-primary,#d33)!important}
`

		const STYLE_TAG_ID = "dsh-true-delete/styles.css"

		function installStyles() {
			if (typeof document === "undefined") return
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
			const tag = document.createElement("style")
			tag.dataset.plugin = "dsh-true-delete"
			tag.dataset.pluginCss = STYLE_TAG_ID
			tag.textContent = CSS
			document.head.appendChild(tag)
		}

		//#endregion

		/** 本插件依赖的客户端服务。 */
		const inject = ["slots", "locale", "workspaces"]

		function apply(ctx) {
			installStyles()
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-true-delete: dictionaries")

			/** 待确认的删除请求；菜单关掉之后对话框还要靠它活着。 */
			const request = client_store.createSnapshotStore(null)

			const workspaces = ctx.get("workspaces")
			const archivedSource =
				workspaces !== undefined && workspaces.list !== undefined
					? workspaces.list
					: {
							getSnapshot: () => EMPTY_SNAPSHOT,
							subscribe: () => () => {},
						}
			const archived = derive(archivedSource, (snapshot) => {
				const ids = snapshot && Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : []
				return ids.length === 0 ? EMPTY_SET : new Set(ids)
			})

			const menuInjected = () => ({
				hooks: { archived },
				requestDelete: (sessionId, displayTitle) => {
					request.set({ sessionId, displayTitle })
				},
			})

			const overlayInjected = () => ({
				hooks: { request },
				settle: () => {
					request.set(null)
				},
				refreshSessions: () => {
					try {
						// 会话客户端服务的公开方法是 refresh()（内部转发给 SessionManager.refreshList）；
						// 万一某个版本只暴露 refreshList，就退回它。
						const sessions = ctx.get("sessions")
						if (typeof sessions?.refresh === "function") sessions.refresh()
						else sessions?.refreshList?.()
					} catch (error) {
						/* 列表刷新是锦上添花：拿不到这个服务就等宿主自己下次刷新 */
					}
				},
			})

			ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
				yield ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "true-delete-menu",
						order: 500,
						locale: NS,
						inject: menuInjected,
					},
					DeleteArchivedMenuItem,
				)
			})

			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register(
					{
						name: "shell.overlay",
						id: "true-delete-confirm",
						locale: NS,
						inject: overlayInjected,
					},
					ArchiveCleanerOverlay,
				)
			})
		}

		exports.name = "dsh-true-delete"
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})

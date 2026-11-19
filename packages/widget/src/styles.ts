/** All widget CSS lives in the Shadow DOM, so host page styles cannot leak in or out. */
export const STYLES = /* css */ `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
.ea-panel{
  --ea-bg:#ffffff;--ea-fg:#16181d;--ea-muted:#5f6672;--ea-faint:#8b929c;--ea-border:#e4e6ea;--ea-surface:#f3f4f6;
  --ea-surface-2:#f8f9fa;--ea-code-bg:#f3f4f6;--ea-shadow:0 12px 48px rgba(16,24,40,.18),0 2px 8px rgba(16,24,40,.08);
  --ea-danger:#b42318;--ea-focus:var(--ea-accent);
  position:fixed;bottom:88px;right:20px;width:400px;height:min(680px,calc(100vh - 108px));height:min(680px,calc(100dvh - 108px));
  display:flex;flex-direction:column;background:var(--ea-bg);color:var(--ea-fg);border:1px solid var(--ea-border);
  border-radius:var(--ea-radius);box-shadow:var(--ea-shadow);overflow:hidden;
  font:14.5px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue","Noto Sans","PingFang SC","Hiragino Sans","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;text-align:left;opacity:0;transform:translateY(12px) scale(.98);
  transform-origin:bottom right;transition:opacity .16s ease,transform .16s ease,width .2s ease,height .2s ease;pointer-events:none;visibility:hidden}
.ea-panel.ea-left{right:auto;left:20px;transform-origin:bottom left}
.ea-panel.ea-open{opacity:1;transform:none;pointer-events:auto;visibility:visible}
.ea-panel.ea-expanded{width:min(760px,calc(100vw - 40px));height:calc(100vh - 108px);height:calc(100dvh - 108px)}
.ea-panel.ea-dark{--ea-bg:#17181b;--ea-fg:#ececee;--ea-muted:#a4a8b1;--ea-faint:#7d828c;--ea-border:#2c2e33;--ea-surface:#25272c;
  --ea-surface-2:#1e2024;--ea-code-bg:#222429;--ea-shadow:0 12px 48px rgba(0,0,0,.5);--ea-danger:#f97066}
@media (max-width:640px){
  .ea-panel,.ea-panel.ea-expanded{inset:0;width:100%;height:100%;border-radius:0;border:0;transform:translateY(16px)}
  .ea-panel.ea-open{transform:none}
  .ea-expand{display:none!important}
}
/* inline mode: fills the host element, sits in the page flow */
.ea-panel.ea-inline,.ea-panel.ea-inline.ea-open{position:relative;inset:auto;width:100%;height:100%;min-height:360px;
  border-radius:var(--ea-radius);border:1px solid var(--ea-border);box-shadow:none;transform:none;transition:none}
@media (prefers-reduced-motion:reduce){.ea-panel{transition:none}}
.ea-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* header */
.ea-header{display:flex;align-items:center;gap:6px;padding:10px 10px 10px 16px;border-bottom:1px solid var(--ea-border);min-height:54px;flex:none}
.ea-title{flex:1;min-width:0;display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}
.ea-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ea-avatar{width:26px;height:26px;border-radius:50%;background:var(--ea-accent);color:var(--ea-accent-text);display:grid;place-items:center;flex:none}
.ea-icon-btn{width:34px;height:34px;border:0;background:transparent;color:var(--ea-muted);border-radius:8px;display:grid;place-items:center;cursor:pointer;padding:0;flex:none}
.ea-icon-btn:hover{background:var(--ea-surface);color:var(--ea-fg)}
.ea-icon-btn[hidden]{display:none}
button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--ea-focus);outline-offset:2px}

/* body */
.ea-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:smooth;padding:16px 16px 8px}
@media (prefers-reduced-motion:reduce){.ea-body{scroll-behavior:auto}}
.ea-welcome{display:flex;flex-direction:column;gap:14px;padding:18px 4px 8px}
.ea-welcome h2{margin:0;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em}
.ea-suggestions{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.ea-suggestion{text-align:left;font:inherit;color:var(--ea-fg);background:var(--ea-bg);border:1px solid var(--ea-border);border-radius:12px;padding:10px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px}
.ea-suggestion:hover{background:var(--ea-surface-2);border-color:var(--ea-faint)}
.ea-suggestion svg{flex:none;color:var(--ea-faint)}

.ea-msg{margin:0 0 18px;display:flex;flex-direction:column}
.ea-msg-user{align-items:flex-end}
.ea-bubble{max-width:85%;background:var(--ea-surface);padding:9px 14px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.ea-msg-assistant .ea-content{overflow-wrap:anywhere;min-height:1.5em}
.ea-content>:first-child{margin-top:0}.ea-content>:last-child{margin-bottom:0}
.ea-content p{margin:0 0 10px}
.ea-content h3,.ea-content h4{margin:14px 0 6px;font-size:15px;line-height:1.35}
.ea-content ul,.ea-content ol{margin:0 0 10px;padding-left:22px}
.ea-content li{margin:3px 0}
.ea-content a{color:var(--ea-accent-link);text-decoration:underline;text-underline-offset:2px}
.ea-content code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--ea-code-bg);padding:1px 5px;border-radius:5px}
.ea-content pre{background:var(--ea-code-bg);padding:10px 12px;border-radius:10px;overflow-x:auto;margin:0 0 10px}
.ea-content pre code{background:none;padding:0;white-space:pre}
.ea-content blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--ea-border);color:var(--ea-muted)}
.ea-content hr{border:0;border-top:1px solid var(--ea-border);margin:12px 0}
.ea-table{overflow-x:auto;margin:0 0 10px}
.ea-content table{border-collapse:collapse;font-size:13.5px}
.ea-content th,.ea-content td{border:1px solid var(--ea-border);padding:5px 8px;text-align:left;vertical-align:top}
.ea-content th{background:var(--ea-surface-2)}
.ea-cite{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;margin:0 1px;border-radius:9px;font-size:10.5px;font-weight:600;
  line-height:1;vertical-align:2px;background:var(--ea-surface);color:var(--ea-muted);text-decoration:none!important;border:0;cursor:pointer;font-family:inherit}
a.ea-cite:hover,button.ea-cite:hover{background:var(--ea-accent);color:var(--ea-accent-text)}
.ea-caret::after{content:"";display:inline-block;width:7px;height:15px;margin-left:2px;vertical-align:-2px;background:var(--ea-fg);opacity:.55;animation:ea-blink 1s steps(2) infinite}
@keyframes ea-blink{50%{opacity:0}}
.ea-status{display:flex;align-items:center;gap:8px;color:var(--ea-muted);font-size:13.5px}
.ea-dots{display:inline-flex;gap:3px}
.ea-dots i{width:5px;height:5px;border-radius:50%;background:currentColor;animation:ea-bounce 1.2s infinite ease-in-out}
.ea-dots i:nth-child(2){animation-delay:.15s}.ea-dots i:nth-child(3){animation-delay:.3s}
@keyframes ea-bounce{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.ea-dots i,.ea-caret::after{animation:none}}

.ea-sources{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.ea-sources-label{font-size:12px;font-weight:600;color:var(--ea-muted);text-transform:uppercase;letter-spacing:.04em}
.ea-source{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border:1px solid var(--ea-border);border-radius:10px;color:inherit;text-decoration:none;font-size:13px;background:var(--ea-bg)}
a.ea-source:hover{background:var(--ea-surface-2)}
.ea-source b{flex:none;min-width:18px;height:18px;display:grid;place-items:center;border-radius:9px;background:var(--ea-surface);font-size:11px;color:var(--ea-muted)}
.ea-source span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ea-source.ea-flash{border-color:var(--ea-accent)}

.ea-actions{display:flex;gap:2px;margin-top:6px;margin-left:-6px;color:var(--ea-faint)}
.ea-actions .ea-icon-btn{width:30px;height:30px;color:var(--ea-faint)}
.ea-actions .ea-icon-btn[aria-pressed="true"]{color:var(--ea-accent-link)}
.ea-note{font-size:12.5px;color:var(--ea-muted);margin-top:4px}
.ea-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--ea-danger);font-size:13.5px;margin-top:4px}
.ea-link-btn{font:inherit;font-size:13px;background:none;border:1px solid var(--ea-border);color:var(--ea-fg);border-radius:8px;padding:3px 10px;cursor:pointer}
.ea-link-btn:hover{background:var(--ea-surface)}

/* history */
.ea-history{display:flex;flex-direction:column;gap:2px}
.ea-history-item{display:flex;align-items:center;gap:4px;border-radius:10px}
.ea-history-item:hover{background:var(--ea-surface-2)}
.ea-history-open{flex:1;min-width:0;text-align:left;font:inherit;color:var(--ea-fg);background:none;border:0;padding:10px 12px;cursor:pointer;border-radius:10px}
.ea-history-open span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ea-history-open small{display:block;color:var(--ea-faint);font-size:12px}
.ea-empty{color:var(--ea-muted);text-align:center;padding:32px 0}

/* composer */
.ea-footer{padding:8px 12px 10px;flex:none}
.ea-composer{display:flex;align-items:flex-end;gap:6px;border:1px solid var(--ea-border);border-radius:16px;padding:6px 6px 6px 14px;background:var(--ea-bg);transition:border-color .12s}
.ea-composer:focus-within{border-color:var(--ea-faint)}
.ea-input{flex:1;min-width:0;border:0;outline:0;resize:none;background:transparent;color:var(--ea-fg);font:inherit;line-height:1.5;max-height:150px;padding:5px 0;margin:0}
.ea-input:focus-visible{outline:none}
.ea-input::placeholder{color:var(--ea-faint)}
.ea-send{width:34px;height:34px;flex:none;border:0;border-radius:50%;cursor:pointer;display:grid;place-items:center;background:var(--ea-accent);color:var(--ea-accent-text);padding:0}
.ea-send:disabled{opacity:.35;cursor:default}
.ea-disclaimer{margin:7px 4px 0;font-size:11.5px;line-height:1.4;color:var(--ea-faint);text-align:center}
/* tools, approvals, handoff, follow-ups */
.ea-tools{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.ea-tool{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ea-muted);background:var(--ea-surface-2);border:1px solid var(--ea-border);border-radius:999px;padding:3px 10px 3px 8px}
.ea-tool svg{flex:none}
.ea-tool-error{color:var(--ea-danger)}
.ea-spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:ea-rot .8s linear infinite;flex:none}
@keyframes ea-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ea-spin{animation:none}}
.ea-confirm{border:1px solid var(--ea-border);border-radius:12px;padding:12px 14px;margin:4px 0 8px;background:var(--ea-surface-2)}
.ea-confirm p{margin:0 0 4px;font-size:12.5px;color:var(--ea-muted)}
.ea-confirm b{display:block;margin-bottom:6px}
.ea-confirm dl{margin:0 0 10px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}
.ea-confirm dt{color:var(--ea-muted)}
.ea-confirm dd{margin:0;overflow-wrap:anywhere}
.ea-confirm-row{display:flex;gap:8px}
.ea-btn{font:inherit;font-size:13.5px;border-radius:9px;padding:6px 14px;cursor:pointer;border:1px solid var(--ea-border);background:var(--ea-bg);color:var(--ea-fg)}
.ea-btn:hover{background:var(--ea-surface)}
.ea-btn-primary{background:var(--ea-accent);color:var(--ea-accent-text);border-color:transparent}
.ea-btn-primary:hover{background:var(--ea-accent);filter:brightness(.95)}
.ea-btn:disabled{opacity:.5;cursor:default}
.ea-handoff{display:flex;flex-direction:column;align-items:flex-start;gap:8px;border-left:3px solid var(--ea-accent);background:var(--ea-surface-2);padding:10px 12px;border-radius:0 10px 10px 0;margin:6px 0;font-size:13.5px}
.ea-handoff a{color:var(--ea-accent-link)}
.ea-followups{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.ea-followups-label{font-size:12px;font-weight:600;color:var(--ea-muted);text-transform:uppercase;letter-spacing:.04em}
.ea-followup{align-self:flex-start;max-width:100%;text-align:left;font:inherit;font-size:13.5px;color:var(--ea-fg);background:var(--ea-bg);border:1px solid var(--ea-border);border-radius:10px;padding:6px 12px;cursor:pointer}
.ea-followup:hover{background:var(--ea-surface-2);border-color:var(--ea-faint)}
.ea-banner{margin:8px 16px 0;padding:8px 12px;border-radius:10px;background:var(--ea-surface);color:var(--ea-muted);font-size:13px}
`;

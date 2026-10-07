export const css = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
@keyframes cc-pop{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}
@keyframes cc-msg{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cc-dot{0%,60%,100%{transform:translateY(0);opacity:.35}30%{transform:translateY(-4px);opacity:1}}
@keyframes cc-pulse{0%{box-shadow:0 0 0 0 rgba(28,126,214,.45)}70%{box-shadow:0 0 0 14px rgba(28,126,214,0)}100%{box-shadow:0 0 0 0 rgba(28,126,214,0)}}
@keyframes cc-badge{from{transform:scale(0)}to{transform:scale(1)}}
.btn{position:fixed;right:20px;bottom:20px;width:62px;height:62px;border-radius:50%;background:linear-gradient(135deg,#339af0,#1864ab);color:#fff;border:0;cursor:pointer;box-shadow:0 6px 18px rgba(24,100,171,.35);z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .2s ease,box-shadow .2s ease}
.btn:hover{transform:scale(1.07);box-shadow:0 8px 24px rgba(24,100,171,.45)}
.btn.attn{animation:cc-pulse 2s infinite}
.btn svg{width:28px;height:28px;transition:transform .25s ease}
.btn.opened svg{transform:rotate(90deg)}
.badge{position:absolute;top:-2px;right:-2px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#fa5252;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;animation:cc-badge .25s ease}
.panel{position:fixed;right:20px;bottom:94px;width:370px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 114px);background:#fff;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000;color:#1a1a1a;transform-origin:bottom right;animation:cc-pop .28s cubic-bezier(.2,.9,.3,1.2)}
.panel.inline{position:fixed;inset:0;width:100%;height:100%;max-height:none;max-width:none;border-radius:0;animation:none}
.head{background:linear-gradient(135deg,#228be6,#1864ab);color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.head .ttl{display:flex;align-items:center;gap:10px;min-width:0}
.avatar{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex:none}
.avatar svg{width:20px;height:20px}
.head .name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.head .sub{font-size:12px;opacity:.85;display:flex;align-items:center;gap:5px}
.head .sub i{width:8px;height:8px;border-radius:50%;background:#69db7c;display:inline-block}
.head button{background:rgba(255,255,255,.15);border:0;color:#fff;width:30px;height:30px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
.head button:hover{background:rgba(255,255,255,.3)}
.body{flex:1;overflow-y:auto;padding:14px 12px;background:#f4f6f8;scroll-behavior:smooth}
.m{max-width:80%;margin:6px 0;padding:9px 12px;border-radius:16px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;animation:cc-msg .22s ease both}
.m.in{margin-left:auto;background:linear-gradient(135deg,#339af0,#1c7ed6);color:#fff;border-bottom-right-radius:5px}
.m.out{background:#fff;border:1px solid #e9ecef;border-bottom-left-radius:5px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.m.system{margin:8px auto;background:none;color:#868e96;font-size:12px;text-align:center;box-shadow:none}
.m .who{font-size:11px;color:#868e96;margin-bottom:2px;font-weight:600}
.m a{color:inherit}
.m.failed{opacity:.6;border:1px dashed #e03131}
.m.pending{opacity:.75}
.typing{display:flex;align-items:center;gap:8px;margin:6px 0;animation:cc-msg .2s ease both}
.typing .dots{background:#fff;border:1px solid #e9ecef;border-radius:16px;border-bottom-left-radius:5px;padding:10px 12px;display:flex;gap:4px}
.typing .dots span{width:7px;height:7px;border-radius:50%;background:#868e96;animation:cc-dot 1.2s infinite}
.typing .dots span:nth-child(2){animation-delay:.15s}
.typing .dots span:nth-child(3){animation-delay:.3s}
.typing .lbl{font-size:12px;color:#868e96}
.foot{display:flex;gap:6px;padding:10px;border-top:1px solid #e9ecef;align-items:flex-end;background:#fff}
textarea{flex:1;resize:none;border:1px solid #dee2e6;border-radius:12px;padding:9px 11px;font-size:14px;max-height:100px;outline:none;transition:border-color .15s,box-shadow .15s}
textarea:focus{border-color:#339af0;box-shadow:0 0 0 3px rgba(51,154,240,.15)}
.icon{background:#f1f3f5;border:0;border-radius:12px;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#495057;transition:background .15s}
.icon:hover{background:#e9ecef}
.icon svg{width:20px;height:20px}
.send{background:linear-gradient(135deg,#339af0,#1c7ed6);color:#fff}
.send:hover{background:linear-gradient(135deg,#228be6,#1864ab)}
.form{padding:18px;display:flex;flex-direction:column;gap:10px;font-size:14px;overflow-y:auto}
.form .greet{background:#f1f3f5;border-radius:12px;padding:10px 12px;animation:cc-msg .25s ease both}
.form input{border:1px solid #dee2e6;border-radius:10px;padding:10px;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
.form input:focus{border-color:#339af0;box-shadow:0 0 0 3px rgba(51,154,240,.15)}
.form input.need{border-left:3px solid #f08c00}
.hint{color:#868e96;font-size:12px}
button{transition:transform .08s ease}
button:active:not(:disabled){transform:scale(.95)}
.form label{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#495057}
.primary{background:linear-gradient(135deg,#339af0,#1c7ed6);color:#fff;border:0;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
.primary:disabled{opacity:.5}
.err{color:#e03131;font-size:12px}
.notice{margin:0 10px 6px;padding:8px 10px;border-radius:10px;background:#fff4e6;color:#d9480f;font-size:12px}
.btns{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px;animation:cc-msg .22s ease both}
.btns button{background:#fff;border:1px solid #339af0;color:#1c7ed6;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer;transition:background .15s}
.btns button:hover{background:#e7f5ff}
.csat{text-align:center;margin:6px 0 10px;font-size:13px;color:#495057}
.csat button{background:#fff;border:1px solid #ced4da;border-radius:8px;width:38px;height:34px;margin:4px 3px;cursor:pointer;font-size:14px}
.csat button:hover{border-color:#f08c00;background:#fff4e6}
.chip{font-size:12px;background:#e7f5ff;border-radius:6px;padding:3px 6px;margin:0 8px 6px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

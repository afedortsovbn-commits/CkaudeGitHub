export const css = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.btn{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;background:#1c7ed6;color:#fff;border:0;font-size:26px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000}
.panel{position:fixed;right:20px;bottom:90px;width:360px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 110px);background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000;color:#1a1a1a}
.panel.inline{position:fixed;inset:0;width:100%;height:100%;max-height:none;max-width:none;border-radius:0}
.head{background:#1c7ed6;color:#fff;padding:12px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
.head button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}
.body{flex:1;overflow-y:auto;padding:12px;background:#f4f6f8}
.m{max-width:80%;margin:6px 0;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}
.m.in{margin-left:auto;background:#1c7ed6;color:#fff;border-bottom-right-radius:4px}
.m.out{background:#fff;border:1px solid #e3e6ea;border-bottom-left-radius:4px}
.m.system{margin:8px auto;background:none;color:#868e96;font-size:12px;text-align:center}
.m .who{font-size:11px;color:#868e96;margin-bottom:2px}
.m a{color:inherit}
.m.failed{opacity:.6;border:1px dashed #e03131}
.foot{display:flex;gap:6px;padding:8px;border-top:1px solid #e9ecef;align-items:flex-end}
textarea{flex:1;resize:none;border:1px solid #ced4da;border-radius:8px;padding:8px;font-size:14px;max-height:100px}
.icon{background:#f1f3f5;border:0;border-radius:8px;width:38px;height:38px;cursor:pointer;font-size:18px}
.send{background:#1c7ed6;color:#fff}
.form{padding:16px;display:flex;flex-direction:column;gap:10px;font-size:14px}
.form input{border:1px solid #ced4da;border-radius:8px;padding:9px;font-size:14px}
.form label{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#495057}
.primary{background:#1c7ed6;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;cursor:pointer}
.primary:disabled{opacity:.5}
.typing{font-size:12px;color:#868e96;padding:0 14px 6px}
.err{color:#e03131;font-size:12px}
.btns{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}
.btns button{background:#fff;border:1px solid #1c7ed6;color:#1c7ed6;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer}
.btns button:hover{background:#e7f5ff}
.csat{text-align:center;margin:6px 0 10px;font-size:13px;color:#495057}
.csat button{background:#fff;border:1px solid #ced4da;border-radius:8px;width:38px;height:34px;margin:4px 3px;cursor:pointer;font-size:14px}
.csat button:hover{border-color:#f08c00;background:#fff4e6}
.chip{font-size:12px;background:#e7f5ff;border-radius:6px;padding:3px 6px;margin:0 8px 6px}
`;

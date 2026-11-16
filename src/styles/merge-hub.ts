/** Merge review: B layout, using application theme tokens throughout. */
export const mergeHubStyles = `
.mh-root{flex:1;min-width:0;min-height:0;overflow:auto;background:var(--bg-root);color:var(--text-primary);container-type:inline-size}
.mh-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 11px;border:1px solid var(--border-medium);border-radius:7px;background:var(--bg-panel);color:var(--text-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}
.mh-button:hover:not(:disabled){background:var(--bg-hover);border-color:var(--border-strong)}
.mh-button:focus-visible,.mh-inbox-item:focus-visible,.mh-report-editor:focus-visible,.mh-search:focus-within{outline:2px solid var(--accent);outline-offset:2px}
.mh-button:disabled{opacity:.45;cursor:not-allowed}
.mh-button[data-variant=primary]{background:var(--primary-action-bg);color:var(--primary-action-fg);border-color:var(--primary-action-bg)}
.mh-button[data-variant=primary]:hover:not(:disabled){background:var(--primary-action-hover)}
.mh-button[data-variant=danger]{background:var(--danger);border-color:var(--danger);color:var(--fg-on-accent)}
.mh-button[data-variant=danger]:hover:not(:disabled){background:color-mix(in srgb,var(--danger) 85%,var(--text-primary))}
.mh-top{display:flex;align-items:center;gap:18px;min-height:60px;padding:12px 32px;border-bottom:1px solid var(--border-dim);font-size:11px;color:var(--text-muted)}
.mh-back{background:transparent;border-color:transparent;padding-left:0}
.mh-body{max-width:1440px;margin:0 auto;padding:32px 36px 40px}
.mh-heading{display:flex;justify-content:space-between;align-items:center;gap:20px}
.mh-eyebrow{font-size:9px;letter-spacing:2px;color:var(--text-hint);font-weight:600;margin-bottom:8px}
.mh-heading h1{font-size:27px;line-height:1.3;font-weight:650;letter-spacing:-.6px;margin:0}
.mh-heading p{font-size:12px;color:var(--text-muted);margin:9px 0 0;line-height:1.7}
.mh-summary{display:flex;gap:28px;margin:26px 0 22px;color:var(--text-muted);font-size:11px}
.mh-summary b{font-size:19px;font-weight:500;color:var(--text-primary);margin-right:8px;font-variant-numeric:tabular-nums}
.mh-summary>span+span{border-left:1px solid var(--border-medium);padding-left:28px}
.mh-tools{display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--border-medium);margin-bottom:20px;flex-wrap:wrap}
.mh-tabs{display:flex;gap:22px}
.mh-tabs .mh-button{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:13px 0;color:var(--text-muted)}
.mh-tabs .mh-button[aria-pressed=true]{color:var(--text-primary);font-weight:600;border-bottom-color:var(--accent)}
.mh-filters{display:flex;gap:12px;align-items:center;min-width:0;flex-wrap:wrap;padding:5px 0}
.mh-search{display:flex;align-items:center;gap:8px;color:var(--text-hint);border-radius:4px}
.mh-search input{background:transparent;border:0;outline:none;color:var(--text-primary);font:inherit;font-size:11px;width:190px;min-width:80px;padding:6px 0}
.mh-repo-filter{max-width:210px;min-width:110px;justify-content:space-between;font-size:11px}
.mh-repo-filter>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mh-select-content{max-width:min(380px,90vw);max-height:var(--radix-select-content-available-height);background:var(--bg-panel);color:var(--text-primary);border:1px solid var(--border-medium);border-radius:8px;padding:5px;z-index:1100;box-shadow:0 8px 24px var(--border-medium)}
.mh-select-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 11px;font-size:12px;border-radius:5px;cursor:pointer;outline:none;overflow-wrap:anywhere}
.mh-select-item[data-highlighted]{background:var(--bg-hover)}
.mh-select-item[data-state=checked]{color:var(--accent)}
.mh-message{display:flex;align-items:center;gap:12px;padding:11px 14px;border:1px solid var(--border-dim);border-radius:8px;background:var(--bg-subtle);font-size:12px;line-height:1.7;margin-bottom:15px;overflow-wrap:anywhere}
.mh-message .mh-button{margin-left:auto}
.mh-error{color:var(--danger);white-space:pre-wrap;overflow-wrap:anywhere}
.mh-split{display:grid;grid-template-columns:minmax(250px,.8fr) minmax(0,1.4fr);border:1px solid var(--border-dim);border-radius:12px;overflow:hidden;min-height:440px;align-items:start}
.mh-inbox{background:var(--bg-sidebar);border-right:1px solid var(--border-dim);padding:8px;max-height:680px;overflow-y:auto;align-self:stretch;min-width:0;scrollbar-gutter:stable}
.mh-inbox-item{display:block;width:100%;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text-primary);padding:14px;font:inherit;cursor:pointer;margin-bottom:5px}
.mh-inbox-item:hover{background:var(--bg-hover)}
.mh-inbox-item[aria-pressed=true]{background:var(--bg-panel);border-color:var(--border-medium);box-shadow:0 3px 12px var(--border-dim)}
.mh-meta{display:flex;justify-content:space-between;gap:10px;color:var(--text-muted);font-size:10px;flex-wrap:wrap;overflow-wrap:anywhere}
.mh-inbox-item h3{font-size:12px;font-weight:600;line-height:1.7;margin:9px 0 12px;overflow-wrap:anywhere}
.mh-row-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mh-badge{display:inline-flex;font-size:10px;line-height:1.5;border-radius:5px;padding:3px 7px;background:var(--bg-subtle);color:var(--text-muted);white-space:nowrap}
.mh-badge[data-state=TO_BE_MERGED],.mh-badge[data-state=APPROVED],.mh-badge[data-state=MERGED]{color:var(--success);background:color-mix(in srgb,var(--success) 10%,transparent)}
.mh-badge[data-state=UNDER_REVIEW],.mh-badge[data-state=UNDER_DEV]{color:var(--accent);background:var(--accent-subtle)}
.mh-conflict{color:var(--warning);font-size:10px}
.mh-detail{padding:28px;min-width:0}
.mh-detail-top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
.mh-detail-top>span:last-child{font-size:10px;color:var(--text-muted);overflow-wrap:anywhere}
.mh-detail h2{font-size:23px;line-height:1.5;font-weight:600;margin:20px 0;overflow-wrap:anywhere}
.mh-branches{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:11px;flex-wrap:wrap;margin:10px 0 24px;user-select:text}
.mh-branches code{background:var(--bg-subtle);border-radius:4px;padding:3px 6px;overflow-wrap:anywhere;max-width:100%}
.mh-people{display:grid;grid-template-columns:1fr 1.5fr;gap:25px;border-top:1px solid var(--border-dim);padding-top:22px;color:var(--text-muted);font-size:11px}
.mh-people strong{display:block;color:var(--text-primary);font-weight:500;margin-top:8px;overflow-wrap:anywhere}
.mh-checklist{background:var(--bg-subtle);border-radius:8px;padding:18px;margin:24px 0}
.mh-checklist h3{font-size:13px;font-weight:600;margin:0}
.mh-checklist p{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--text-muted);margin:17px 0 0}
.mh-checklist strong{margin-left:auto;color:var(--text-secondary);font-size:11px;font-weight:500}
.mh-checklist p[data-warning=true] strong{color:var(--warning)}
.mh-actions{display:flex;flex-wrap:wrap;gap:8px}
.mh-actions .mh-button{padding:7px 9px;font-size:11px}
.mh-close-button{margin-top:18px;padding-left:0;border-color:transparent;background:transparent;color:var(--text-muted);font-size:11px}
.mh-close-button:hover:not(:disabled){color:var(--danger);background:var(--danger-surface);border-color:transparent}
.mh-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:15px;font-size:10px;color:var(--text-muted);flex-wrap:wrap}
.mh-pagination>div{display:flex;align-items:center;gap:12px}
.mh-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:60px 20px;color:var(--text-muted);gap:12px}
.mh-empty h3{font-size:14px;margin:0}.mh-empty p{font-size:12px;margin:0}
.mh-overlay{position:fixed;inset:0;background:color-mix(in srgb,var(--text-primary) 25%,transparent);backdrop-filter:blur(3px);z-index:1100}
.mh-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,calc(100vw - 36px));max-height:calc(100dvh - 40px);overflow:auto;padding:28px;background:var(--bg-panel);color:var(--text-primary);border:1px solid var(--border-medium);border-radius:16px;box-shadow:0 24px 100px var(--border-strong);z-index:1101;font-family:var(--font-ui)}
.mh-dialog h2{font-size:20px;line-height:1.4;margin:15px 0 8px}
.mh-dialog p{font-size:12px;line-height:1.8}
.mh-dialog>p:not(.mh-error){color:var(--text-muted)}
.mh-danger-icon{display:inline-flex;padding:11px;border-radius:12px;background:var(--danger-surface);color:var(--danger)}
.mh-close-target{display:flex;flex-direction:column;gap:8px;background:var(--bg-subtle);padding:16px;border-radius:8px;margin:22px 0;overflow-wrap:anywhere}
.mh-close-target strong{font-size:12px}.mh-close-target span,.mh-close-target code{font-size:10px;color:var(--text-muted)}
.mh-dialog-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:22px;flex-wrap:wrap}
.mh-report{width:min(1000px,calc(100vw - 40px));height:min(800px,calc(100dvh - 60px));display:flex;flex-direction:column;overflow:hidden;padding:24px}
.mh-report-head{display:flex;justify-content:space-between;gap:15px;align-items:flex-start}
.mh-report-head>div{min-width:0}.mh-report-head h2{margin-top:0}.mh-report-head p{color:var(--text-muted);overflow-wrap:anywhere}
.mh-report-tools{display:flex;gap:8px;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid var(--border-dim);margin-bottom:16px}
.mh-report-body{flex:1;min-height:0;overflow:auto;user-select:text}
.mh-report-editor{display:block;resize:vertical;width:100%;height:calc(100% - 50px);min-height:200px;margin-top:12px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-medium);border-radius:8px;padding:14px;font-family:var(--font-mono);font-size:12px;line-height:1.7}
.mh-muted{color:var(--text-muted);font-size:11px}
@container(max-width:900px){.mh-body{padding:26px 24px}.mh-top{padding:12px 24px}.mh-detail{padding:22px}.mh-split{grid-template-columns:minmax(220px,.8fr) minmax(0,1.4fr)}.mh-tools{gap:5px}.mh-filters{padding-bottom:10px}}
@container(max-width:680px){.mh-split{grid-template-columns:minmax(0,1fr)}.mh-inbox{display:flex;overflow-x:auto;max-height:240px;border-right:0;border-bottom:1px solid var(--border-dim);scrollbar-gutter:auto}.mh-inbox-item{flex:0 0 230px;max-width:85%;margin:0 6px 0 0}.mh-detail h2{font-size:20px}.mh-body{padding:22px 18px}.mh-summary{gap:14px}.mh-summary>span+span{padding-left:14px}.mh-filters{width:100%;justify-content:space-between}.mh-repo-filter{max-width:180px}.mh-heading h1{font-size:23px}}
`;

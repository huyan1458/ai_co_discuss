import"./plot-area-frame-DNYMd9Pf-B0ScWz_J.js";import{o as e,t}from"./pptx-DbjWegUB-CU8ZIJEP.js";var n=1,r=`
:where(.ooxml-comment-marker) {
  padding: 0;
  border: 0;
  cursor: pointer;
  pointer-events: auto;
  background: transparent;
  box-shadow: none;
  color: var(--ooxml-comment-marker-color, var(--ooxml-comment-author-accent));
}
:where([data-ooxml-comment-highlight]) {
  position: absolute;
  pointer-events: none;
  background: var(--ooxml-comment-highlight, color-mix(in srgb, var(--ooxml-comment-author-accent) 18%, transparent));
  transform-origin: top left;
}
:where([data-ooxml-comment-highlight][data-active="true"]) {
  background: var(--ooxml-comment-highlight-active, color-mix(in srgb, var(--ooxml-comment-author-accent) 34%, transparent));
}
:where([data-ooxml-comment-target]) {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  border-style: solid;
  border-color: var(--ooxml-comment-target-border, #2563eb);
  background: var(--ooxml-comment-target-background, rgba(37, 99, 235, .06));
  transform-origin: center;
}
:where(.ooxml-comment-card) {
  position: relative;
  display: block;
  width: 100%;
  margin: 0 0 var(--ooxml-comment-card-gap, .42em);
  box-sizing: border-box;
  padding: var(--ooxml-comment-card-padding, .56em .68em);
  border: 0;
  border-radius: var(--ooxml-comment-card-radius, .3em);
  text-align: start;
  cursor: default;
  font: inherit;
  outline: none;
  background: var(--ooxml-comment-card-background, #fff);
  box-shadow: var(--ooxml-comment-card-shadow, none);
}
:where(button.ooxml-comment-card) {
  cursor: pointer;
}
:where(.ooxml-comment-card[data-standalone="true"]) {
  position: absolute;
  width: max-content;
  max-width: 100%;
  margin: 0;
  z-index: 3;
  pointer-events: none;
  overflow: hidden;
  font-size: 13px;
}
:where(.ooxml-comment-card[data-active="true"]) {
  background: var(--ooxml-comment-card-active-background, #eff6ff);
  box-shadow: var(--ooxml-comment-card-active-shadow, none);
}
:where(.ooxml-comment-card[data-focused="true"]) {
  box-shadow: var(--ooxml-comment-card-focus-shadow, 0 0 0 .12em rgba(37, 99, 235, .65));
}
:where(.ooxml-comment-card [data-ooxml-comment-part="content"]) {
  min-width: 0;
  flex: 1;
}
:where(.ooxml-comment-card [data-ooxml-comment-part="identity"]) {
  display: flex;
  align-items: baseline;
  gap: .48em;
  min-width: 0;
}
:where(.ooxml-comment-card__author) {
  min-width: 0;
  font: 700 .84em/1.3 var(--ooxml-comment-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color: var(--ooxml-comment-author-color, #0f172a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:where(.ooxml-comment-card__date) {
  font: 500 .66em/1.35 var(--ooxml-comment-date-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  color: var(--ooxml-comment-muted-color, #64748b);
  white-space: nowrap;
}
:where(.ooxml-comment-card__body) {
  margin-top: .28em;
  font: 400 .84em/1.45 var(--ooxml-comment-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  color: var(--ooxml-comment-body-color, #334155);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
:where(.ooxml-comment-card__reply) {
  margin: .55em 0 0 .45em;
  padding: .08em 0 0 .65em;
  border-left: .08em solid var(--ooxml-comment-reply-border, rgba(100, 116, 139, .24));
}
:where(.ooxml-comment-card [data-ooxml-comment-part="frame"]) {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: inherit;
  border: var(--ooxml-comment-card-border, 1px solid rgba(148, 163, 184, .34));
  border-left: var(--ooxml-comment-card-border-left, .14em solid var(--ooxml-comment-author-accent));
  border-right: var(--ooxml-comment-card-border-right, var(--ooxml-comment-card-border, 1px solid rgba(148, 163, 184, .34)));
}
:where(.ooxml-comment-card[data-active="true"] [data-ooxml-comment-part="frame"]) {
  border: var(--ooxml-comment-card-active-border, 1px solid rgba(37, 99, 235, .5));
  border-left: var(--ooxml-comment-card-border-left, .14em solid var(--ooxml-comment-author-accent));
  border-right: var(--ooxml-comment-card-border-right, var(--ooxml-comment-card-active-border, 1px solid rgba(37, 99, 235, .5)));
}
:where([data-ooxml-comment-ui="margin"] > [data-ooxml-comment-item]) {
  position: absolute;
  left: 0;
  padding: 0 .14em;
  box-sizing: border-box;
  transform-origin: 0 0;
}
:where([data-ooxml-comment-ui="margin"] > [data-ooxml-comment-item]:last-child > .ooxml-comment-card) {
  margin-bottom: 0;
}
`;function i(e){let t=e.head;if(!t||t.querySelector(`style[data-ooxml-comment-styles]`))return;let n=e.createElement(`style`);n.dataset.ooxmlCommentStyles=``,n.textContent=r,t.appendChild(n)}function a(e){if(!e)return`#2563eb`;let t=2166136261;for(let n of e.normalize(`NFKC`))t^=n.codePointAt(0)??0,t=Math.imul(t,16777619);return`hsl(${(t>>>0)%360} 68% 42%)`}function o(e,t){i(e);let n=e.createElement(`button`);return n.type=`button`,n.setAttribute(`class`,`ooxml-comment-marker`),n.dataset.ooxmlCommentId=t.occurrenceKey,n.dataset.ooxmlCommentMarker=``,n.dataset.active=String(t.active),n.setAttribute(`aria-label`,`Comment ${t.visibleIndex+1}`),n.setAttribute(`aria-pressed`,String(t.active)),n.style.cssText=`--ooxml-comment-author-accent:${a(t.author)};position:absolute;transform:translate(-50%,-50%);width:${24*t.zoom}px;height:${24*t.zoom}px;`,n.innerHTML=`<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M18 4C18.7956 4 19.5587 4.31607 20.1213 4.87868C20.6839 5.44129 21 6.20435 21 7V15C21 15.7956 20.6839 16.5587 20.1213 17.1213C19.5587 17.6839 18.7956 18 18 18H13L8 21V18H6C5.20435 18 4.44129 17.6839 3.87868 17.1213C3.31607 16.5587 3 15.7956 3 15V7C3 6.20435 3.31607 5.44129 3.87868 4.87868C4.44129 4.31607 5.20435 4 6 4H18Z"/></svg>`,n.addEventListener(`click`,()=>t.onSetActive(t.occurrenceKey,!t.active)),n}var s=new WeakMap;function c(e,t){t&&typeof t.unobserve==`function`&&t.unobserve(e.card),e.card.removeEventListener(`click`,e.onClick),e.card.removeEventListener(`focus`,e.onFocus),e.card.removeEventListener(`blur`,e.onBlur),e.item.remove()}function l(e){let t=s.get(e);s.delete(e);for(let e of t?.cards.values()??[])c(e,t?.resizeObserver);t?.cards.clear(),t&&e.removeEventListener(`scroll`,t.onScroll),t?.resizeObserver?.disconnect(),e.replaceChildren()}function u(e,t){let n=s.get(e);if(!n||n.cards.size===0||!Number.isFinite(t)||t<=0)return!1;let r=Number.parseFloat(e.dataset.ooxmlCommentZoom??``),i=Number.isFinite(r)&&r>0?r:n.zoom*t;for(let e of n.cards.values())e.item.style.top=`${e.committedTop*i}px`,e.item.style.transform=`scale(${i})`;return!0}function d(e,t=``){let n=e.createElement(`div`);return n.style.cssText=t,n}function f(e){if(!e)return;let t=new Date(e);return Number.isFinite(t.getTime())?new Intl.DateTimeFormat(void 0,{dateStyle:`medium`,timeStyle:`short`}).format(t):e}function p(e,t){return e.messageKey===t.messageKey&&e.sourceId===t.sourceId&&e.author===t.author&&e.date===t.date&&e.text===t.text&&e.status===t.status}function m(e,t){return e.occurrenceKey===t.occurrenceKey&&p(e.root,t.root)&&e.replies.length===t.replies.length&&e.replies.every((e,n)=>p(e,t.replies[n]))}function h(e,t,n){let r=e.map((e,t)=>({...e,index:t})).sort((e,t)=>e.preferredTop-t.preferredTop||e.index-t.index),i=Math.max(0,n),a=r.reduce((e,t)=>e+Math.max(0,t.height),0)+i*Math.max(0,r.length-1);if(t<=0||a>t){let e=0;return new Map(r.map(t=>{let n=[t.occurrenceKey,e];return e+=Math.max(0,t.height)+i,n}))}let o=r.map(e=>Math.max(0,Math.min(e.preferredTop,t-e.height)));for(let e=1;e<r.length;e++){let t=o[e-1]+r[e-1].height+i;o[e]=Math.max(o[e],t)}if(r.length>0){let e=r.length-1;o[e]=Math.min(o[e],t-r[e].height);for(let t=e-1;t>=0;t--)o[t]=Math.min(o[t],o[t+1]-i-r[t].height);if(o[0]<0){let e=-o[0];for(let t=0;t<o.length;t++)o[t]+=e}}return new Map(r.map((e,t)=>[e.occurrenceKey,o[t]]))}function g(e,t,n){let r=e.ownerDocument,i=d(r);n&&i.setAttribute(`class`,`ooxml-comment-card__reply`),i.dataset.ooxmlCommentPart=n?`reply`:`comment`;let a=d(r);a.dataset.ooxmlCommentPart=`content`;let o=d(r);o.dataset.ooxmlCommentPart=`identity`;let s=d(r);s.setAttribute(`class`,`ooxml-comment-card__author`),s.dataset.ooxmlCommentPart=`author`,s.textContent=t.author||`Comment`,o.appendChild(s);let c=f(t.date);if(c){let e=d(r);e.setAttribute(`class`,`ooxml-comment-card__date`),e.dataset.ooxmlCommentPart=`date`,e.textContent=c,e.setAttribute(`title`,t.date),o.appendChild(e)}let l=d(r);l.setAttribute(`class`,`ooxml-comment-card__body`),l.dataset.ooxmlCommentPart=`body`,l.textContent=t.text,a.appendChild(o),a.appendChild(l),i.appendChild(a),e.appendChild(i)}function _(e,t,n={}){i(e.ownerDocument);let r=n.active??!1,o=n.focused??!1,s=n.interactive??e.tagName===`BUTTON`,c=a(t.root.author);e.setAttribute(`class`,`ooxml-comment-card`),e.dataset.ooxmlCommentId=t.occurrenceKey,e.dataset.active=String(r),e.dataset.focused=String(o),e.dataset.standalone=String(n.standalone??!1),e.dataset.ooxmlCommentCard=``,s?e.setAttribute(`aria-pressed`,String(r)):e.removeAttribute(`aria-pressed`),e.style.cssText=`--ooxml-comment-author-accent:${c};`,e.replaceChildren(),g(e,t.root,!1);for(let n of t.replies)g(e,n,!0);let l=d(e.ownerDocument);l.dataset.ooxmlCommentPart=`frame`,l.setAttribute(`aria-hidden`,`true`),e.appendChild(l)}function v(e,t,r){e.setAttribute(`role`,`list`),e.setAttribute(`aria-label`,`Comments`),e.dataset.ooxmlCommentUi=`margin`,e.dataset.ooxmlCommentZoom=String(r.zoom);let i=s.get(e);if(!i){let t={cards:new Map,onScroll:()=>t.onScrollGeometryChange?.(),zoom:r.zoom,onGeometryChange:r.onGeometryChange,onScrollGeometryChange:r.onScrollGeometryChange};if((r.onGeometryChange||r.onScrollGeometryChange)&&e.addEventListener(`scroll`,t.onScroll,{passive:!0}),r.onGeometryChange){let n=e.ownerDocument.defaultView?.ResizeObserver??globalThis.ResizeObserver;n&&(t.resizeObserver=new n(()=>t.onGeometryChange?.()))}i=t,s.set(e,i)}i.zoom=r.zoom,i.onGeometryChange=r.onGeometryChange,i.onScrollGeometryChange=r.onScrollGeometryChange;let a=new Set;for(let e of t){if(a.has(e.occurrenceKey))throw Error(`Duplicate comment occurrence key: ${e.occurrenceKey}`);a.add(e.occurrenceKey)}for(let[e,t]of[...i.cards])a.has(e)||(i.cards.delete(e),c(t,i.resizeObserver));for(let a of t){let t=i.cards.get(a.occurrenceKey);if(!t){let o=d(e.ownerDocument);o.setAttribute(`role`,`listitem`),o.dataset.ooxmlCommentItem=``;let s=e.ownerDocument.createElement(`button`);s.type=`button`,s.id=`ooxml-comment-card-${n++}`,s.dataset.ooxmlCommentCard=``;let c={item:o,card:s,thread:a,painted:!1,focused:!1,active:!1,committedTop:0,onSetActive:r.onSetActive,onClick:()=>c.onSetActive(a.occurrenceKey,!c.active),onFocus:()=>{c.focused=!0,c.card.dataset.focused=`true`},onBlur:()=>{c.focused=!1,c.card.dataset.focused=`false`}};s.addEventListener(`click`,c.onClick),s.addEventListener(`focus`,c.onFocus),s.addEventListener(`blur`,c.onBlur),o.appendChild(s),i.cards.set(a.occurrenceKey,c),i.resizeObserver?.observe(s),t=c}let o=r.activeId===a.occurrenceKey;t.onSetActive=r.onSetActive,(!t.painted||t.active!==o||!m(t.thread,a))&&_(t.card,a,{active:o,focused:t.focused,interactive:!0}),t.painted=!0,t.active=o,t.thread=a}let o=t.map((e,t)=>({thread:e,index:t})).sort((e,t)=>(r.preferredTopById?.get(e.thread.occurrenceKey)??0)-(r.preferredTopById?.get(t.thread.occurrenceKey)??0)||e.index-t.index).map(({thread:e})=>e).flatMap(e=>{let t=i.cards.get(e.occurrenceKey);return t?[t.item]:[]});(o.length!==e.children.length||o.some((t,n)=>e.children[n]!==t))&&e.replaceChildren(...o);for(let e of i.cards.values())e.item.style.cssText=`width:${r.logicalWidth}px;top:${e.committedTop*r.zoom}px;`;let l=o[0]?.children[0],u=l&&e.ownerDocument.defaultView?.getComputedStyle?Number.parseFloat(e.ownerDocument.defaultView.getComputedStyle(l).marginBottom):0,f=h(t.map(e=>{let t=i.cards.get(e.occurrenceKey);return{occurrenceKey:e.occurrenceKey,preferredTop:(r.preferredTopById?.get(e.occurrenceKey)??0)/r.zoom,height:t?.card.getBoundingClientRect().height??0}}),e.clientHeight/r.zoom,Number.isFinite(u)?u:0);for(let e of i.cards.values())e.committedTop=f.get(e.thread.occurrenceKey)??0,e.item.style.top=`${e.committedTop*r.zoom}px`,e.item.style.transform=`scale(${r.zoom})`;return new Map(t.flatMap(e=>{let t=i.cards.get(e.occurrenceKey);return t?[[e.occurrenceKey,t.card]]:[]}))}function y(e,t){let n=Math.max(e.x,t.x),r=Math.max(e.y,t.y),i=Math.min(e.x+e.width,t.x+t.width),a=Math.min(e.y+e.height,t.y+t.height);if(!(i<=n||a<=r))return Object.freeze({x:n,y:r,width:i-n,height:a-r})}function b(e,t){let n=e.getBoundingClientRect(),r=t.getBoundingClientRect();if([n.left,n.top,n.width,n.height,r.left,r.top].every(Number.isFinite)&&!(n.width<=0||n.height<=0))return Object.freeze({x:n.left-r.left,y:n.top-r.top,width:n.width,height:n.height})}function x(e,t){let n=e.scrollTop-t;return Object.freeze(e.threads.map(t=>{if(!t.cardRect)return t;let r=Object.freeze({...t.cardRect,y:t.cardRect.y+n}),i=e.cardClipBounds?y(r,e.cardClipBounds):r,{cardRect:a,...o}=t;return Object.freeze({...o,...i?{cardRect:i}:{}})}))}var S=`http://www.w3.org/2000/svg`,C=new WeakMap;function w(e){let t=Math.round(e*1e3)/1e3;return Object.is(t,-0)?`0`:String(t)}function T(e,t){let n=(t.x-e.x)*.5;return[{x:e.x+n,y:e.y},{x:t.x-n,y:t.y}]}function E(e,t,n){let r=e.x+(t.x-e.x)*.55;if(n===`orthogonal`)return`M ${w(e.x)} ${w(e.y)} H ${w(r)} V ${w(t.y)} H ${w(t.x)}`;let[i,a]=T(e,t);return`M ${w(e.x)} ${w(e.y)} C ${w(i.x)} ${w(i.y)}, ${w(a.x)} ${w(a.y)}, ${w(t.x)} ${w(t.y)}`}function D(e){C.delete(e),e.replaceChildren()}function O(e,t,n){e.dataset.ooxmlCommentConnectors=``;let r=C.get(e);if(!r){let t=e.ownerDocument.createElementNS(S,`svg`);t.setAttribute(`aria-hidden`,`true`),t.style.cssText=`position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;`,r={svg:t,paths:new Map},C.set(e,r),e.replaceChildren(t)}r.svg.setAttribute(`viewBox`,`${t.surfaceBounds.x} ${t.surfaceBounds.y} ${t.surfaceBounds.width} ${t.surfaceBounds.height}`);let i=[],a=new Set;for(let o of t.threads){let s=o.anchorRects.at(-1),c=o.cardRect;if(!s||!c)continue;a.add(o.occurrenceKey);let l=t.side===`left`?s.x:s.x+s.width,u=s.y+s.height/2,d=t.side===`left`?c.x+c.width:c.x,f=c.y+Math.min(c.height/2,25),p=r.paths.get(o.occurrenceKey);p||(p=e.ownerDocument.createElementNS(S,`path`),r.paths.set(o.occurrenceKey,p)),p.dataset.ooxmlCommentConnector=o.occurrenceKey,p.dataset.active=String(o.active),p.setAttribute(`d`,E({x:l,y:u},{x:d,y:f},n.route)),p.style.cssText=`fill:none;vector-effect:non-scaling-stroke;stroke:${o.active?n.activeColor??n.color??`#2563eb`:n.color??`#94a3b8`};stroke-width:${o.active?`1.5px`:`1px`};stroke-dasharray:${n.stroke===`dashed`?`4 4`:`none`};opacity:${o.active?`.9`:`.45`};`,i.push(p)}for(let[e,t]of[...r.paths])a.has(e)||(r.paths.delete(e),t.remove());(i.length!==r.svg.children.length||i.some((e,t)=>r.svg.children[t]!==e))&&r.svg.replaceChildren(...i)}function k(e,t,n){return{messageKey:`${t}:reply:${e.id??n}`,sourceId:e.id,author:e.author,date:e.date,text:e.text,status:e.status}}function A(n,r,a,s,c,l,u,d,f,p,m,h,g=!1,_,y){i(n.ownerDocument),r&&(r.dataset.ooxmlCommentZoom=String(p)),n.replaceChildren();let x=a.map((e,n)=>({comment:e,index:n,id:t(e,n,c)})).filter(({comment:e})=>g||e.status!==`resolved`&&e.status!==`closed`),S=new Map,C=new Map,w=new Map(s.map(e=>[e.elementId,e])),T=n.parentElement;for(let[t,r]of x.entries()){let{comment:i,id:a}=r,s=(i.anchors??[]).flatMap(e=>{if(e.type!==`drawingElement`&&e.type!==`textRange`||!e.elementId)return[];let t=w.get(e.elementId);return t?[t]:[]});if(d===a)for(let t of s){let r=n.ownerDocument.createElement(`div`);r.dataset.ooxmlCommentTarget=a,r.style.cssText=`left:${e(t.bounds.x,l)};top:${e(t.bounds.y,u)};width:${e(t.bounds.width,l)};height:${e(t.bounds.height,u)};border-width:${2*p}px;transform:rotate(${t.bounds.rotation}deg);`,n.appendChild(r)}let c=s[0]?.bounds,m=Number.isFinite(i.x)&&Number.isFinite(i.y);if(!m&&!c)continue;let g=Math.max(0,Math.min(c?c.x+(m?i.x:c.width):i.x,l)),_=Math.max(0,Math.min(c?c.y+(m?i.y:0):i.y,u));if(S.set(a,Object.freeze({x:g/9525*p-24*p/2,y:_/9525*p-24*p/2,width:24*p,height:24*p})),d===a&&s.length===0&&!h){let t=n.ownerDocument.createElement(`div`);t.dataset.ooxmlCommentTarget=a,t.style.cssText=`left:${e(g,l)};top:${e(_,u)};width:${24*p}px;height:${24*p}px;border-width:${2*p}px;border-radius:50%;transform:translate(-50%,-50%);`,n.appendChild(t)}if(h){let r=o(n.ownerDocument,{occurrenceKey:a,visibleIndex:t,author:i.author,active:d===a,zoom:p,onSetActive:f});r.style.left=e(g,l),r.style.top=e(_,u),n.appendChild(r),C.set(a,r)}}let E=x.map(({comment:e,id:t})=>({occurrenceKey:t,root:{messageKey:`${t}:root`,sourceId:e.id,author:e.author,date:e.date,text:e.text,status:e.status},replies:e.replies?.map((e,n)=>k(e,t,n))??[]})),D=r?v(r,E,{activeId:d,zoom:p,logicalWidth:m,onSetActive:f,onGeometryChange:_,onScrollGeometryChange:y,preferredTopById:new Map(E.map(e=>{let t=S.get(e.occurrenceKey);return[e.occurrenceKey,t?.y??0]}))}):new Map;for(let e of x){let t=D.get(e.id),n=C.get(e.id);t?.id&&n&&n.setAttribute(`aria-controls`,t.id)}if(!_&&!y)return Object.freeze({threads:Object.freeze(E.map(e=>{let t=S.get(e.occurrenceKey);return Object.freeze({occurrenceKey:e.occurrenceKey,active:d===e.occurrenceKey,anchorRects:Object.freeze(t?[t]:[])})})),scrollTop:r?.scrollTop??0});let O=r&&T?b(r,T):void 0,A=Object.freeze(E.map(e=>{let t=D.get(e.occurrenceKey),n=t&&T?b(t,T):void 0,r=S.get(e.occurrenceKey);return Object.freeze({occurrenceKey:e.occurrenceKey,active:d===e.occurrenceKey,anchorRects:Object.freeze(r?[r]:[]),...n?{cardRect:n}:{}})}));return Object.freeze({threads:A,...O?{cardClipBounds:O}:{},scrollTop:r?.scrollTop??0})}export{A as buildPptxCommentMargin,O as buildReadOnlyCommentDecoration,D as disposeReadOnlyCommentDecoration,l as disposeReadOnlyCommentMargin,u as previewReadOnlyCommentMargin,x as projectReadOnlyCommentMarginScroll};
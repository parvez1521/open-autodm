/**
 * Brand intro — concept adopted 2026-11-09 from the Open Caption
 * reference (owner directive: same style AND animation concepts).
 *
 * Inline <head> script for the landing page's brand moment
 * (components/home/BrandIntro.tsx). It runs before first paint:
 *   <html data-intro="play|skip">  plays once per browser session
 *   .ce-go   added once the sheet is painted with its fonts: the
 *            sheet's content animation starts here, so a slow load
 *            can never "use up" the intro before anyone sees it
 *   .ce-out  the sheet lifts and the hero's [data-hero] entrance is
 *            released (globals.css holds it paused until then)
 *
 * Timeline: originally compressed to the owner's ~1.2s cap;
 * lengthened 2026-11-10 (owner directive ~02:19 IST) when the
 * sheet's content became a three-beat workflow animation
 * (IntroWorkflow) — the exit is now forced 1650ms after .ce-go
 * (the beats land by ~1.7s) and the attribute is cleaned up by
 * 2.5s. The page is NEVER trapped — every path (reduced motion,
 * coarse pointer, repeat visit, JS error, slow fonts) resolves
 * to "skip" or a forced exit.
 */
export const introScript = `(function(){try{
var h=document.documentElement;if(location.pathname!=="/")return;
if(matchMedia("(prefers-reduced-motion: reduce)").matches||matchMedia("(pointer:coarse)").matches){h.dataset.intro="skip";return}
try{if(sessionStorage.getItem("oadm_intro")){h.dataset.intro="skip";return}sessionStorage.setItem("oadm_intro","1")}catch(e){}
h.dataset.intro="play";
var started=false;
function go(){if(started)return;started=true;requestAnimationFrame(function(){requestAnimationFrame(function(){
h.classList.add("ce-go");
setTimeout(function(){h.classList.add("ce-out")},1650);
setTimeout(function(){h.dataset.intro="skip"},2500);
})})}
function wait(){if(!document.querySelector(".oadm-intro")){requestAnimationFrame(wait);return}
var f=document.fonts&&document.fonts.ready;if(f){Promise.race([f,new Promise(function(r){setTimeout(r,600)})]).then(go)}else go()}
wait();setTimeout(go,1800);
}catch(e){}})();`;

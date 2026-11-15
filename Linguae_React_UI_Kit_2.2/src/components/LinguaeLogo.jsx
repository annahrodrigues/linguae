import React from 'react';
/** Official Hidden Chameleon L symbol. SVG scales cleanly at any size. */
export default function LinguaeLogo({compact=false,showTagline=true,className=''}) {
  return <div className={`linguae-logo ${compact?'linguae-logo--compact':''} ${className}`.trim()} aria-label="Linguae — Learn. Adapt. Connect.">
    <img className="linguae-logo__symbol" src="/assets/linguae-monogram.svg" alt="" aria-hidden="true" />
    <span className="linguae-logo__type"><strong>Linguae</strong>{showTagline&&<small>LEARN. ADAPT. CONNECT.</small>}</span>
  </div>;
}

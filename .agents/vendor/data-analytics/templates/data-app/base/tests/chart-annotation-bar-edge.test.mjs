import assert from "node:assert/strict";
import test from "node:test";
import { chartAnnotationArrow, chartAnnotationBarArrow, layoutChartAnnotations } from "../src/charting/chart-annotation-layout.js";

function roundedBar(x=200,y=100,width=60,height=160,radius=20) {
  const r=Math.min(radius,width/2,height/2);
  return {x,y,width,height,contains(p) {
    if(p.x<x||p.x>x+width||p.y<y||p.y>y+height)return false;
    const cx=Math.max(x+r,Math.min(x+width-r,p.x));
    const cy=Math.max(y+r,Math.min(y+height-r,p.y));
    return Math.hypot(p.x-cx,p.y-cy)<=r;
  }};
}

test("bar arrows end just outside the actual rounded edge facing the label",()=>{
  const bar=roundedBar();
  for(const [horizontal,anchor,label]of[
    [false,{x:230,y:100},{x:50,y:40,width:100,height:40}],
    [false,{x:230,y:260},{x:50,y:280,width:100,height:40}],
    [true,{x:200,y:180},{x:50,y:140,width:100,height:40}],
    [true,{x:260,y:180},{x:320,y:140,width:100,height:40}],
  ]) {
    const box={...label,anchor};const before=structuredClone(box);
    const arrow=chartAnnotationBarArrow(box,[bar],horizontal);
    assert.ok(arrow,"Positive and negative vertical/horizontal endpoints retain a connector");
    assert.ok(arrow.control,"A clear bar connector uses a gentle quadratic curve");
    assert.notDeepEqual(arrow.end,anchor,"The visual target is an actual edge, not a dot at the reviewed value");
    assert.equal(bar.contains(arrow.end),false);
    const dx=arrow.end.x-arrow.start.x,dy=arrow.end.y-arrow.start.y,length=Math.hypot(dx,dy);
    assert.equal(bar.contains({x:arrow.end.x+dx/length*5,y:arrow.end.y+dy/length*5}),false,
      "A deliberate 6px tip gap stays clear of the fill");
    assert.ok(bar.contains({x:arrow.end.x+dx/length*7,y:arrow.end.y+dy/length*7}),
      "The tip follows the visible edge with consistent padding, not an arbitrary offset");
    for(const [a,b,c]of[[arrow.start,arrow.end,arrow.control],[arrow.left,arrow.end],[arrow.end,arrow.right]])
      for(let t=0;t<=1;t+=0.02)assert.equal(bar.contains(c
        ?{x:(1-t)**2*a.x+2*(1-t)*t*c.x+t*t*b.x,y:(1-t)**2*a.y+2*(1-t)*t*c.y+t*t*b.y}
        :{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}),false);
    assert.deepEqual(box,before,"Reviewed anchor and caller geometry remain unchanged");
  }
});

test("bar curves are deterministic, align the head to the endpoint tangent, and fall back when obstructed",()=>{
  const bar=roundedBar();
  const box={x:0,y:150,width:40,height:60,anchor:{x:200,y:180}};
  const curved=chartAnnotationBarArrow(box,[bar],true);
  assert.ok(curved.control);
  assert.deepEqual(chartAnnotationBarArrow(box,[bar],true),curved);
  const tangent={x:curved.end.x-curved.control.x,y:curved.end.y-curved.control.y};
  const headMid={x:(curved.left.x+curved.right.x)/2,y:(curved.left.y+curved.right.y)/2};
  assert.ok(Math.abs((curved.end.x-headMid.x)*tangent.y-(curved.end.y-headMid.y)*tangent.x)<1e-7,
    "The arrowhead follows the curve's last tangent, not its overall chord");
  const middle={x:(curved.start.x+2*curved.control.x+curved.end.x)/4,
    y:(curved.start.y+2*curved.control.y+curved.end.y)/4};
  const blocker={x:middle.x-2,y:middle.y+1.8,width:4,height:1};
  const straight=chartAnnotationBarArrow(box,[bar],true,[blocker]);
  assert.ok(straight);
  assert.equal(straight.control,undefined,"An unsafe curve uses the clear straight connector");
  assert.deepEqual(straight.end,curved.end,"Fallback preserves the actual-edge padding");
});

test("short Mesa arrows leave six pixels beside the text and the bar without moving either",()=>{
  const bar=roundedBar(100,80,200,33,4);
  const box={x:333,y:75.5,width:160,height:42,anchor:{x:300,y:96.5}};
  const before=structuredClone(box);
  const arrow=chartAnnotationBarArrow(box,[bar],true);
  assert.ok(arrow,"Padding must not turn the short connector into a detached figure note");
  assert.ok(Math.abs(box.x-arrow.start.x-6)<0.01,"Leave a gap at the text end");
  assert.ok(Math.abs(arrow.end.x-bar.x-bar.width-6)<0.01,"Keep the painted-face gap");
  assert.ok(Math.abs(Math.hypot(arrow.end.x-arrow.start.x,arrow.end.y-arrow.start.y)-21)<0.01);
  assert.ok(arrow.control,"The shortened connector retains its gentle curve");
  assert.deepEqual(box,before,"Padding changes the connector, not the label or reviewed anchor");
});

test("plot boundaries constrain the actual curve and arrowhead, with straight then note fallback",()=>{
  const plot={x:0,y:0,width:400,height:300};
  const label={x:0,y:30,width:100,height:60};
  const edgeBar=roundedBar(0,160,2,140,0);
  const box={...label,anchor:{x:1,y:160}};
  assert.ok(chartAnnotationBarArrow(box,[edgeBar]),"Without plot bounds this narrow mark exposes the clipping regression");
  assert.equal(chartAnnotationBarArrow(box,[edgeBar],false,[],plot),null,
    "Neither the curved nor straight head fits; use the readable figure note");
  const insetBar=roundedBar(3.4,160,2,140,0);
  const insetBox={...label,anchor:{x:4.4,y:160}};
  assert.ok(chartAnnotationBarArrow(insetBox,[insetBar]).left.x<plot.x);
  const straight=chartAnnotationBarArrow(insetBox,[insetBar],false,[],plot);
  assert.ok(straight);
  assert.equal(straight.control,undefined,"A clipped curved head can still use a fully in-plot straight arrow");
  for(const point of[straight.start,straight.end,straight.left,straight.right])
    assert.ok(point.x>=plot.x&&point.x<=plot.width&&point.y>=plot.y&&point.y<=plot.height);
});

test("missing, ambiguous, zero-size, or mismatched painted bars never receive a guessed connector",()=>{
  const bar=roundedBar();
  const box={x:50,y:40,width:100,height:40,anchor:{x:230,y:100}};
  for(const bars of[[],[bar,roundedBar()],[roundedBar(300)],[{...bar,height:0}],
    [{...bar,contains:undefined}],[{...bar,contains:()=>false}]])
    assert.equal(chartAnnotationBarArrow(box,bars),null);
  assert.equal(chartAnnotationBarArrow({...box,anchor:{x:215,y:100}},[bar]),null,
    "A nearby category or rounded corner cannot stand in for the exact category center");
  assert.equal(chartAnnotationBarArrow({...box,anchor:{x:230,y:150}},[bar]),null,
    "An interior value is not the endpoint of this bar");
});

test("a long horizontal bar gets a face-normal arrow rather than a shallow crossing arrowhead",()=>{
  const bar=roundedBar(91,99.6,602,21,4);
  const box={x:533,y:25.6,width:173,height:42,anchor:{x:693,y:110.1}};
  const arrow=chartAnnotationBarArrow(box,[bar],true);
  assert.ok(arrow);
  assert.equal(arrow.start.x,arrow.end.x,"The flat face directly below the label gives a vertical connector");
  assert.ok(Math.abs(arrow.end.y-(bar.y-6))<0.01);
  assert.equal(bar.contains(arrow.left),false);
  assert.equal(bar.contains(arrow.right),false);
});

test("a label overlapping a rounded bar end keeps a perpendicular 6px gap",()=>{
  // Actual supplier geometry: projecting the label center hit the rounded
  // corner and fell back to the bar center, leaving only 1.82px of clearance.
  const bar=roundedBar(75.6,151.12,420.267,33,8);
  const box={x:438.3667,y:77.12,width:114.734,height:42,anchor:{x:495.867,y:167.62}};
  for(const horizontal of[true,false]) {
    const target=horizontal?bar:roundedBar(bar.y,bar.x,bar.height,bar.width,8);
    const label=horizontal?box:{x:box.y,y:box.x,width:box.height,height:box.width,
      anchor:{x:box.anchor.y,y:box.anchor.x}};
    const arrow=chartAnnotationBarArrow(label,[target],horizontal);
    assert.ok(arrow,"The actual overlapping face has room for a connected label");
    assert.ok(Math.abs(horizontal?arrow.start.x-arrow.end.x:arrow.start.y-arrow.end.y)<1e-7);
    assert.ok(Math.abs((horizontal?target.y-arrow.end.y:target.x-arrow.end.x)-6)<0.01,
      "Padding is perpendicular to the painted face, not a shallow diagonal ray");
  }
});

test("bar connectors never run through another bar or annotation",()=>{
  const bar=roundedBar();
  const box={x:0,y:40,width:60,height:40,anchor:{x:230,y:100}};
  assert.ok(chartAnnotationBarArrow(box,[bar]));
  assert.equal(chartAnnotationBarArrow(box,[bar,roundedBar(100,40,30,90,8)]),null);
  assert.equal(chartAnnotationBarArrow(box,[bar],false,[{x:100,y:50,width:40,height:70}]),null);
});

test("bar-point placement reserves enough space for a visible edge arrow without moving the bar",()=>{
  const bar=roundedBar(220,80,50,180,16);
  const entry={id:"billing",kind:"point",label:"Catch-up invoice posted",anchor:{x:245,y:80},barPoint:true};
  const plot={x:0,y:0,width:500,height:300};
  const [box]=layoutChartAnnotations([entry],plot,{measureText:(text)=>text.length*6,obstacles:[bar]});
  assert.ok(box);
  const arrow=chartAnnotationBarArrow(box,[bar]);
  assert.ok(arrow,"Do not merely remove the circle and let the short-arrow threshold hide the connector");
  assert.ok(Math.hypot(arrow.end.x-arrow.start.x,arrow.end.y-arrow.start.y)>18,
    "A previously eligible shaft retains room for its arrowhead after six pixels of text padding");
  assert.deepEqual(box.anchor,entry.anchor);
  assert.deepEqual([bar.x,bar.y,bar.width,bar.height],[220,80,50,180]);
  const lineArrow=chartAnnotationArrow({...box,anchor:entry.anchor});
  assert.deepEqual(lineArrow.end,entry.anchor,"Ordinary line/area point arrows still target the exact reviewed point");
});

test("connector clearance applies only to its target, preserving usable space beside other bars",()=>{
  const target=roundedBar(70,20,60,230,4),other=roundedBar(270,0,60,250,4);
  const entry={id:"approval",kind:"point",label:"Recorded approval requirement",anchor:{x:100,y:20},barPoint:true};
  const result=layoutChartAnnotations([entry],{x:0,y:0,width:400,height:250},
    {measureText:(text)=>text.length*9,obstacles:[target,other]});
  assert.equal(result.length,1,"Do not force a figure note when full text fits between the reviewed bars");
  const [box]=result;
  assert.equal(box.lines.join(" "),entry.label);
  assert.ok(box.x>=162-1e-7 && box.x+box.width<=262+1e-7);
  assert.ok(chartAnnotationBarArrow(box,[target,other]),"The gap accommodates a real noncrossing edge connector");
});

test("failed buffered-bar searches do not hide later ordinary or different-bar labels",()=>{
  const target=roundedBar(0,32,300,68,4),other=roundedBar(270,10,20,10,4);
  const plot={x:0,y:0,width:300,height:100};
  const blocked={id:"blocked",kind:"point",label:"A contextual fact",barPoint:true,anchor:{x:150,y:32}};
  const options={measureText:text=>text.length*6,obstacles:[target,other]};
  assert.deepEqual(layoutChartAnnotations([blocked],plot,options),[],
    "Only the first target's expanded connector buffer fills the plot");
  for(const next of [{...blocked,id:"ordinary",barPoint:false},
    {...blocked,id:"other",anchor:{x:280,y:10}}]) {
    const expected=layoutChartAnnotations([next],plot,options);
    assert.equal(expected.length,1,"The unbuffered first bar leaves a full-text pocket above it");
    assert.deepEqual(layoutChartAnnotations([blocked,next],plot,options),expected);
  }
});

test("dense bar fallback reuses only full-plot failures across distinct targets",()=>{
  const plot={x:50,y:10,width:720,height:260};
  const run=(count,horizontal=false)=>{
    let reads=0;
    const bars=Array.from({length:5000},(_,index)=>{
      const geometry={x:50+index/5000*716,y:12+(index*37)%250,width:6,height:6};
      return Object.defineProperties({contains(p){return p.x>=geometry.x&&p.x<=geometry.x+6
        &&p.y>=geometry.y&&p.y<=geometry.y+6;}},Object.fromEntries(Object.entries(geometry)
        .map(([key,value])=>[key,{get(){reads++;return value;},enumerable:true}])));
    });
    const labels=Array.from({length:count},(_,index)=>{
      const bar=bars[80+index*600];
      return {id:String(index),kind:"point",barPoint:true,horizontal,label:"A supported story about the business",
        anchor:horizontal?{x:bar.x+6,y:bar.y+3}:{x:bar.x+3,y:bar.y}};
    });
    reads=0;
    const result=layoutChartAnnotations(labels,plot,{measureText:text=>text.length*7,obstacles:bars});
    assert.deepEqual(result,[],"Dense painted bars leave full-text figure notes, not unsafe labels");
    return reads;
  };
  const single=run(1),multiple=run(8);
  assert.ok(multiple<single*3,
    `Eight target bars must not repeat the same full-plot obstacle sweep: ${multiple} versus ${single} geometry reads`);
  assert.ok(run(8,true)<single*3,"Horizontal bars retain their bounded same-category fallback");
});

test("a full three-line bar note stays on its reviewed category before using another row's whitespace",()=>{
  for(const horizontal of[true,false])for(const negative of[false,true]){
    const raw=[4,6,8,10].map((value,index)=>roundedBar(75.6,19.12+index*66,value*52.533375,33,4));
    const transformed=raw.map(bar=>negative?roundedBar(781.6-bar.x-bar.width,bar.y,bar.width,bar.height,4):bar);
    const bars=horizontal?transformed:transformed.map(bar=>roundedBar(bar.y*2,bar.x,bar.height*2,bar.width,4));
    const target=bars[2],anchor=horizontal?{x:negative?target.x:target.x+target.width,y:target.y+target.height/2}
      :{x:target.x+target.width/2,y:negative?target.y:target.y+target.height};
    const plot=horizontal?{x:75.6,y:10,width:630.4,height:264}:{x:20,y:75.6,width:528,height:630.4};
    const entry={id:"mesa",kind:"point",barPoint:true,horizontal,
      label:"Mesa’s quote excludes final-mile delivery.",anchor,preferred:horizontal?"right":undefined};
    const [box]=layoutChartAnnotations([entry],plot,{measureText:text=>text.length*9,obstacles:bars});
    assert.ok(box,"Use the available space beyond the actual target bar");
    const category=horizontal?"y":"x",extent=horizontal?"height":"width";
    assert.ok(Math.abs(box[category]+box[extent]/2-anchor[category])<1e-7,
      "The note's center identifies Mesa, never the neighboring Harbor row");
    assert.equal(box.lines.join(" "),entry.label);
    if(horizontal&&!negative)assert.equal(box.lines.length,3,"A nearby three-line phrase beats a distant two-line block");
    assert.ok(chartAnnotationBarArrow(box,bars,horizontal,[],plot));
  }
});

test("actual SVG float rounding cannot reject clear space beside the reviewed bar",()=>{
  const bar=roundedBar(75.5999984741211,151.1199951171875,420.2666931152344,33,4);
  const entry={id:"mesa",kind:"point",barPoint:true,horizontal:true,preferred:"right",
    label:"Mesa’s quote excludes final-mile delivery.",anchor:{x:495.8666666666666,y:167.5}};
  const [box]=layoutChartAnnotations([entry],{x:75.6,y:10,width:630.4,height:252},
    {measureText:text=>text.length*7,obstacles:[bar]});
  assert.ok(box,"Scale doubles and getBBox float32 values must not disagree about a legal tangent gap");
  assert.equal(box.y+box.height/2,entry.anchor.y);
  assert.ok(chartAnnotationBarArrow(box,[bar],true));
  assert.deepEqual(layoutChartAnnotations([entry],{x:75.6,y:10,width:480,height:252},
    {measureText:text=>text.length*7,obstacles:[bar]}),[],"When the actual row has no room, retain a full note rather than move to another row");
});

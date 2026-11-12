"use strict";
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { getWesternScale } = require("./helpers");

const C = { maroon:"#7d2f45", gold:"#d98a2b", ink:"#24212a", muted:"#77717c", border:"#e7dfd4", cream:"#fbf8f2", white:"#ffffff", stripe:"#f8f5ef" };
const clean = (v, fallback="-") => { const s=String(v == null ? "" : v).replace(/\s+/g," ").trim(); return s || fallback; };
function humanDate(value) {
  const m=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return clean(value);
  return new Date(+m[1],+m[2]-1,+m[3]).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
}
function generateSessionPlanPdf({sessionDate,submissions=[]}) {
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:"A4",layout:"portrait",margins:0,autoFirstPage:false,bufferPages:true,info:{Title:`Bhajan Session Plan - ${sessionDate}`,Author:"Sri Sathya Sai Seva Organisation, Gandhinagar",Subject:"Official ordered bhajan session sequence"}});
  const chunks=[]; doc.on("data",b=>chunks.push(b)); doc.on("error",reject); doc.on("end",()=>resolve(Buffer.concat(chunks)));
  const W=595.28,H=841.89,L=27,R=W-L,CW=R-L,footerY=H-30,limit=footerY-12;
  const logoLeft=path.join(__dirname,"../public/images/logo.png"),logoRight=path.join(__dirname,"../public/images/logo_birthday.png");
  const hasLeft=fs.existsSync(logoLeft),hasRight=fs.existsSync(logoRight);
  const cols=[{k:"n",t:"#",w:25,a:"center"},{k:"singer",t:"SINGER / ACCOMPANIST",w:102},{k:"title",t:"BHAJAN",w:185,b:true},{k:"deity",t:"DEITY",w:78},{k:"scale",t:"PITCH / SCALE",w:91},{k:"tempo",t:"TEMPO",w:CW-481}];
  let x=L; cols.forEach(c=>{c.x=x;x+=c.w;});
  function pageHeader(){
   doc.addPage({size:"A4",layout:"portrait",margins:0});
   const top=17,logoSize=48,centerX=L+55,centerW=CW-110;
   if(hasLeft){try{doc.image(logoLeft,L,top,{fit:[logoSize,logoSize]});}catch(e){console.warn("Left logo skipped:",e.message);}}
   if(hasRight){try{doc.image(logoRight,R-logoSize,top,{fit:[logoSize,logoSize]});}catch(e){console.warn("Right logo skipped:",e.message);}}
   doc.fillColor(C.maroon).font("Times-Bold").fontSize(9.5).text("|| AUM SRI SAI RAM ||",centerX,top+1,{width:centerW,align:"center",lineBreak:false});
   doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(9.5).text("SRI SATHYA SAI SEVA ORGANISATION, GANDHINAGAR",centerX,top+16,{width:centerW,align:"center",lineBreak:false,ellipsis:true});
   doc.fillColor(C.muted).font("Helvetica").fontSize(6.3).text("Satyadeep, 20, Gayatri Society, Vasna Hadmatiya, Sargasan, Gandhinagar - 382015",centerX,top+31,{width:centerW,align:"center",lineBreak:false,ellipsis:true});
   doc.fontSize(6.2).text("Email: ssso.gandhinagar@gmail.com  •  Helpline: +91 9265056242",centerX,top+41,{width:centerW,align:"center",lineBreak:false});
   const dy=top+60; doc.rect(L,dy,CW,3).fill(C.maroon); doc.rect(L,dy+4,CW,1.5).fill(C.gold);
   const by=dy+12; doc.roundedRect(L,by,CW,39,4).fillAndStroke(C.cream,C.border); doc.rect(L,by,4,39).fill(C.maroon);
   doc.fillColor(C.maroon).font("Helvetica-Bold").fontSize(9.2).text(`BHAJAN SCHEDULE  •  ${humanDate(sessionDate).toUpperCase()}`,L+12,by+7,{width:CW-24,lineBreak:false,ellipsis:true});
   doc.fillColor(C.muted).font("Helvetica").fontSize(7.4).text(`Official Order of Offerings  •  Total Scheduled Bhajans: ${submissions.length}`,L+12,by+23,{width:CW-24,lineBreak:false});
   const ty=by+52,hh=23; doc.rect(L,ty,CW,hh).fill(C.maroon); doc.rect(L,ty+hh-2,CW,2).fill(C.gold);
   cols.forEach(c=>doc.fillColor(C.white).font("Helvetica-Bold").fontSize(6.4).text(c.t,c.x+3,ty+7,{width:c.w-6,align:c.a||"left",lineBreak:false,ellipsis:true}));
   doc.y=ty+hh;
  }
  function drawRow(item,index){
   const west=getWesternScale(item.scale),partner=clean(item.partner_name,"");
   const vals={n:String(index+1),singer:partner?`${clean(item.singer_name)}\nWith: ${partner}`:clean(item.singer_name),title:clean(item.title),deity:clean(item.deity).toUpperCase(),scale:west!=="-"?`${clean(item.scale)}  |  ${west}`:clean(item.scale),tempo:clean(item.speed,"Medium").toUpperCase()};
   let rh=27; cols.forEach(c=>{doc.font(c.b?"Helvetica-Bold":"Helvetica").fontSize(7.25);rh=Math.max(rh,doc.heightOfString(vals[c.k],{width:c.w-9,lineGap:1.1})+12);});
   if(doc.y+rh>limit) pageHeader();
   const y=doc.y; doc.rect(L,y,CW,rh).fill(index%2===0?C.white:C.stripe); doc.strokeColor(C.border).lineWidth(.45).moveTo(L,y+rh).lineTo(R,y+rh).stroke();
   cols.forEach(c=>doc.fillColor(C.ink).font(c.b?"Helvetica-Bold":"Helvetica").fontSize(7.25).text(vals[c.k],c.x+4.5,y+6,{width:c.w-9,height:rh-12,align:c.a||"left",lineGap:1.1}));
   let sx=L; cols.slice(0,-1).forEach(c=>{sx+=c.w;doc.strokeColor(C.border).lineWidth(.4).moveTo(sx,y).lineTo(sx,y+rh).stroke();});
   doc.y=y+rh;
  }
  try{
   pageHeader();
   if(!submissions.length) doc.fillColor(C.muted).font("Helvetica").fontSize(9).text("No bhajans are scheduled for this session.",L,doc.y+24,{width:CW,align:"center"});
   else submissions.forEach(drawRow);
   const range=doc.bufferedPageRange();
   for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);doc.strokeColor(C.gold).lineWidth(.8).moveTo(L,footerY).lineTo(R,footerY).stroke();doc.fillColor(C.maroon).font("Times-Italic").fontSize(7.5).text("Love All • Serve All  |  Help Ever, Hurt Never",L,footerY+7,{width:CW,align:"center",lineBreak:false});doc.fillColor(C.muted).font("Helvetica").fontSize(6.5).text(`Page ${i+1} of ${range.count}`,L,footerY+7,{width:CW,align:"right",lineBreak:false});}
   doc.end();
  }catch(e){reject(e);}
 });
}
module.exports={generateSessionPlanPdf};

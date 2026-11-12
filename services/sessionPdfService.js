"use strict";
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { getWesternScale } = require("./helpers");

const C = { maroon:"#7d2f45", gold:"#d98a2b", ink:"#24212a", muted:"#77717c", border:"#e7dfd4", cream:"#fbf8f2", white:"#ffffff", stripe:"#f8f5ef" };
const clean = (v, fallback="-") => { const s=String(v == null ? "" : v).replace(/\\s+/g," ").trim(); return s || fallback; };
function humanDate(value) {
  const m=String(value||"").match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  if(!m) return clean(value);
  return new Date(+m[1],+m[2]-1,+m[3]).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
}
function generateSessionPlanPdf({sessionDate,submissions}) {
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:"A4",layout:"landscape",margins:0,autoFirstPage:false,bufferPages:true,info:{Title:`Bhajan Session Plan - ${sessionDate}`,Author:"Sri Sathya Sai Seva Organisation, Gandhinagar",Subject:"Official ordered bhajan session sequence"}});
  const chunks=[]; doc.on("data",b=>chunks.push(b)); doc.on("error",reject); doc.on("end",()=>resolve(Buffer.concat(chunks)));
  const W=841.89,H=595.28,L=34,R=W-34,CW=R-L,footerY=H-31,limit=footerY-12;
  const logo=path.join(__dirname,"../public/images/logo.png"),hasLogo=fs.existsSync(logo);
  const cols=[{k:"n",t:"#",w:32,a:"center"},{k:"singer",t:"SINGER / ACCOMPANIST",w:132},{k:"title",t:"BHAJAN",w:300,b:true},{k:"deity",t:"DEITY",w:112},{k:"scale",t:"PITCH / SCALE",w:92},{k:"tempo",t:"TEMPO",w:CW-668}];
  let x=L; cols.forEach(col=>{col.x=x;x+=col.w;});
  function pageHeader(){
   doc.addPage({size:"A4",layout:"landscape",margins:0});
   const top=24;
   if(hasLogo){try{doc.image(logo,L,top,{fit:[52,52]});}catch(e){console.warn("PDF logo skipped:",e.message);}}
   const tx=hasLogo?L+62:L,tw=CW-(hasLogo?62:0);
   doc.fillColor(C.maroon).font("Times-Bold").fontSize(10).text("|| AUM SRI SAI RAM ||",tx,top+1,{width:tw,align:"center"});
   doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(13).text("SRI SATHYA SAI SEVA ORGANISATION, GANDHINAGAR",tx,top+17,{width:tw,align:"center"});
   doc.fillColor(C.muted).font("Helvetica").fontSize(7.5).text("Satyadeep, 20, Gayatri Society, Vasna Hadmatiya, Sargasan, Gandhinagar - 382015",tx,top+34,{width:tw,align:"center"});
   doc.fontSize(7.2).text("Email: ssso.gandhinagar@gmail.com  •  Helpline: +91 9265056242",tx,top+46,{width:tw,align:"center"});
   const dy=top+68; doc.rect(L,dy,CW,3).fill(C.maroon); doc.rect(L,dy+4,CW,1.5).fill(C.gold);
   const by=dy+14; doc.roundedRect(L,by,CW,43,4).fillAndStroke(C.cream,C.border); doc.rect(L,by,4,43).fill(C.maroon);
   doc.fillColor(C.maroon).font("Helvetica-Bold").fontSize(11).text(`BHAJAN SCHEDULE  •  ${humanDate(sessionDate).toUpperCase()}`,L+13,by+8,{width:CW-26,lineBreak:false,ellipsis:true});
   doc.fillColor(C.muted).font("Helvetica").fontSize(8.5).text(`Official Order of Offerings  •  Total Scheduled Bhajans: ${submissions.length}`,L+13,by+25,{width:CW-26,lineBreak:false});
   const ty=by+57,hh=25; doc.rect(L,ty,CW,hh).fill(C.maroon); doc.rect(L,ty+hh-2,CW,2).fill(C.gold);
   cols.forEach(col=>doc.fillColor(C.white).font("Helvetica-Bold").fontSize(7.2).text(col.t,col.x+4,ty+8,{width:col.w-8,align:col.a||"left",lineBreak:false,ellipsis:true}));
   doc.y=ty+hh;
  }
  function drawRow(item,index){
   const west=getWesternScale(item.scale),partner=clean(item.partner_name,"");
   const vals={n:String(index+1),singer:partner?`${clean(item.singer_name)}\\nWith: ${partner}`:clean(item.singer_name),title:clean(item.title),deity:clean(item.deity).toUpperCase(),scale:west!=="-"?`${clean(item.scale)}  |  ${west}`:clean(item.scale),tempo:clean(item.speed,"Medium").toUpperCase()};
   let rh=30; cols.forEach(col=>{doc.font(col.b?"Helvetica-Bold":"Helvetica").fontSize(8.4);rh=Math.max(rh,doc.heightOfString(vals[col.k],{width:col.w-10,lineGap:1.5})+14);});
   if(doc.y+rh>limit) pageHeader();
   const y=doc.y; doc.rect(L,y,CW,rh).fill(index%2===0?C.white:C.stripe); doc.strokeColor(C.border).lineWidth(.45).moveTo(L,y+rh).lineTo(R,y+rh).stroke();
   cols.forEach(col=>doc.fillColor(C.ink).font(col.b?"Helvetica-Bold":"Helvetica").fontSize(8.4).text(vals[col.k],col.x+5,y+7,{width:col.w-10,height:rh-14,align:col.a||"left",lineGap:1.5}));
   let sx=L; cols.slice(0,-1).forEach(col=>{sx+=col.w;doc.strokeColor(C.border).lineWidth(.4).moveTo(sx,y).lineTo(sx,y+rh).stroke();});
   doc.y=y+rh;
  }
  try{
   pageHeader();
   if(!submissions.length) doc.fillColor(C.muted).font("Helvetica").fontSize(10).text("No bhajans are scheduled for this session.",L,doc.y+24,{width:CW,align:"center"});
   else submissions.forEach(drawRow);
   const range=doc.bufferedPageRange();
   for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);doc.strokeColor(C.gold).lineWidth(.8).moveTo(L,footerY).lineTo(R,footerY).stroke();doc.fillColor(C.maroon).font("Times-Italic").fontSize(8).text("Love All • Serve All  |  Help Ever, Hurt Never",L,footerY+7,{width:CW,align:"center",lineBreak:false});doc.fillColor(C.muted).font("Helvetica").fontSize(7).text(`Page ${i+1} of ${range.count}`,L,footerY+7,{width:CW,align:"right",lineBreak:false});}
   doc.end();
  }catch(e){reject(e);}
 });
}
module.exports={generateSessionPlanPdf};

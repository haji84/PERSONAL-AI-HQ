// Offline diagnostic projection only: reported fields are not acceptance evidence.
// Assumes inert records. Proxy reflection can execute user traps; this is not a sandbox.
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function descriptor(record,key){
 try{return Object.getOwnPropertyDescriptor(record,key);}catch{return undefined;}
}
function data(record,key){
 const own=descriptor(record,key);
 return own&&Object.hasOwn(own,'value')?own.value:undefined;
}
export function projectRetestDiagnostic(attempt){
 let retestPresent=false,retestStatus='UNKNOWN',caseCount=null;
 try{
  if(record(attempt)){
   const own=descriptor(attempt,'retest');
   if(own){
    // Presence means observed own property, even if its value cannot be inspected.
    retestPresent=true;
    const retest=Object.hasOwn(own,'value')?own.value:undefined;
    if(record(retest)){
     const status=data(retest,'status');
     if(status==='PASS'||status==='ASSERTION_FAILURE'||status==='SAFETY_REJECTED')retestStatus=status;
     const count=data(retest,'caseCount');
     if(Number.isSafeInteger(count)&&count>=0&&count<=6)caseCount=count;
    }
   }
  }
 }catch{/* Unreadable reflection never supplies an error or raw input to output. */}
 return Object.freeze({retestPresent,retestStatus,caseCount});
}

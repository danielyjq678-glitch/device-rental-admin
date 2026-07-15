require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cloudbase = require('@cloudbase/node-sdk');
const tcb = cloudbase.init({env:process.env.CLOUD_ENV,secretId:process.env.CLOUD_SECRET_ID,secretKey:process.env.CLOUD_SECRET_KEY});
const db = tcb.database();

// Feishu 设备清单 [序列号, 机型, 出租天数, 学校, 出租率, 版本, 颜色, 采购价, 购入日期, 内存]
const raw = [
['G9N7969C70','15pm',0,'华农',0,'国行','原色',4700,null,'256'],
['VQVVT6HWVQ','15pm',0,'广工',0,'国行','白色',4700,null,'256'],
['F17DTBK20D9C','12 Pro',0,'广工',0,'国行','黑色',1300,null,'128'],
['G6TFLHAX0D83','12 Pro',0,'广工',0,'美版','蓝色',1100,null,'128'],
['F2LZ88T6KPJ5','Xs Max',0,'华农',0,'国行','玫瑰金',1100,null,'256'],
['F2NDFZSKPJ4','Xs Max',0,'广工',0,'国行','玫瑰金',1200,'2025.11.12','256'],
['G6TXKN5MKPJ1','Xs Max',0,'深信',0,'国行','银色',900,null,'64'],
['F2LFH1UJKPJ4','Xs Max',0,'广工',0,'国行','银色',1180,null,'256'],
['F72YMGHNKXM5','Xr',0,'广工',0,'国行','黑色',900,null,'128'],
['GONXKAOZKXM6','Xr',0,'深信',0,'国行','黑色',900,null,'128'],
['FFWZKAJNKXM5','Xr',1,'广工',0,'国行','黑色',900,null,'128'],
['G0NYV0LSKXMD','Xr',0,'广药',0,'国行','黑色',900,null,'256'],
['FYMV40XUHFY0','7P',0,'广工',0,'国行','玫瑰金',550,null,'128'],
['5WT4P3K002C034','大疆pocket3',0,'广工',0,'国行','黑色',2350,'2025.11.7','128'],
['5WTZN6G002R634','大疆pocket3',0,'华农',0,'国行','黑色',2250,'2025.11.13','128'],
['5WTCN5M0021MCN','大疆pocket3',0,'华农',0,'国行','黑色',2250,'2025.11.13','128'],
['5WTCN6F00252ZB','大疆pocket3',0,'广工',0,'国行','黑色',2250,'2025.11.13','128'],
['5WTZN5L002H14G','大疆pocket3',1,'广工',0,'国行','黑色',2450,'2025.11.13','128'],
['5WTCN6B0024H6U','大疆pocket3',1,'广工',0,'国行','黑色',2344,'2025.11.13','128'],
['5WTCN5S0022A7G','大疆pocket3',0,'华农',0,'国行','黑色',2225,'2025.12.27','128'],
['5WTCN6U0027UWJ','大疆pocket3',0,'深信',0,'国行','黑色',2225,'2025.12.27','128'],
['5WTZN6B002W8J9','大疆pocket3',0,'广工',0,'国行','黑色',2225,'2025.12.27','128'],
['5WTCN5B0028RU9','大疆pocket3',0,'广工',0,'国行','黑色',2225,'2025.12.27','128'],
['R5CW51WNQJV','三星S23U',1,'广工',0,'国行','黑色',2948,'2025.10.20','12+256'],
['R5CW4102H2J','三星S23U',0,'广工',0,'国行','白色',2700,'2025.11.16','12+256'],
['R5CW92BVD4D','三星S23U',0,'华农',0,'国行','绿色',2800,null,'12+256'],
['R5CW22B3ACH','三星S23U',0,'广工',0,'国行','黑色',2600,null,'12+256'],
['10AF4G01H4002N0','ViVo X200U',0,'广工',0,'国行','黑色',4368,'2025.11.12','12+256'],
['10AF4L01SQ002N8','ViVo X200U',0,'深信',0,'国行','银色',4595,'2025.11.19','12+256'],
['10AF5Y1FQT003QB','ViVo X200U',0,'广工',0,'国行','红色',4380,'2025.11.16','12+512'],
['10AF650Y20003TL','ViVo X200U',0,'华农',0,'国行','白色',4300,null,'16+512'],
['10AF9Q0HKS002D7','vivox300p',0,'广工',0,'国行','黑色',4654,'2025.12.29','12+256'],
['10AFA60Q5S002FM','vivox300p',0,'广工',0,'国行','白色',4420,'2025.12.17','12+256'],
['362','CCD ixus130',0,'深信',0,null,null,2180,'2026.4.23','4'],
['FYQDROD9HFXW','7P',0,'深信',0,null,null,352,'2026.4.1',null],
['10AF4507XC002E6','ViVo X200U',0,'深信',0,null,null,4250,'2026.4.22',null],
['82JXN5900B2C5P','大疆action5pro',0,'广工',0,'国行','黑色',1650,'2026.4.22',null],
['5WTZN7X002L8UK','大疆pocket3',0,'湖南涉外',0,null,null,2050,'2026.4.22',null],
['5WTZMBPO02TK8D','大疆pocket3',0,'广工商',0,null,null,2050,'2026.4.22',null],
['DX3VN9EPHFXW','7P',0,'广工',0.3,null,null,350,'2026.4.25',null],
['C39TQ99AHFY0','7P',0,'华农',0,null,null,350,'2026.4.25',null],
['F2LT5RCHHFY1','7P',0,'华农',0,null,null,350,'2026.4.25',null],
['10AF7K0Y5C0052M','ViVo X200U',0,'华农',0,'国行','白色',4020,'2026.4.27','16+512'],
['10AF4F1Z8E002K0','ViVo X200U',0,'广工',0,'国行','黑色',4020,'2026.4.27','16+512'],
['10AF561B3X0035K','ViVo X200U',0,'华农',0,'国行','黑色',4020,'2026.4.27','16+512'],
['5WTZN5L0023ZEX','大疆pocket3',0,'华立',0,null,null,2050,'2026.4.27',null],
['5WTCN8V002PGLH','大疆pocket3',0,'深信',0,null,null,2050,'2026.4.27',null],
['5WTZN6B002VTKD','大疆pocket3',0,'深信',0,null,null,2050,'2026.4.28',null],
['5WTZN7C00252N4','大疆pocket3',0,'华立',0,null,null,2050,'2026.4.28',null],
['5WTZMBF0020448','大疆pocket3',0,'广工',0,null,null,2050,'2026.4.28',null],
['MYQ9MVWPPF','15plus',0,'广工',0,null,'黑色',null,null,'256'],
['L6TJWW36JD','15pm',0,'广工',0,null,'蓝色',null,null,'256'],
['MPQXYW59LV','15pro',0,'华农',0,null,'蓝色',null,null,'256'],
['HXVGTWWQQN','15',0,'广工',0,null,null,null,null,'128'],
['DNPG16040D9G','12pro',0,'广工',0,null,'蓝色',null,null,'128'],
['FMQJPXKR4H','15pm',0,'广工',0,null,null,null,null,'256'],
['M46LWX43WW','15pm',0,'华农',0,null,null,null,null,'256'],
['H2LPV6X5JP','16pro',0,'华农',0,null,'金色',null,null,'128'],
['MVHH9P09LN','14pro',0,'华农',0,null,'白色',null,null,'128'],
['5WTZN1G002Z534','大疆pocket3',0,'湖南涉外',0,null,'黑色',1900,'2026.5.20',null],
['F2LZ453MKPJ1','Xs Max',0,'湖南涉外',0,null,'白色',800,'2026.5.20','64'],
['G6TXVXDZKPJ2','Xs Max',0,'广机电',0,null,'金',800,'2026.5.20','64'],
['F2MXK2EBKPJ2','Xs Max',0,'广工商',0,null,'金',800,'2026.5.20','64'],
['FCDSYOTCHFXW','7P',0,'湖南涉外',0,null,'黑',350,'2026.5.20','128'],
['C39THFQLHFXW','7P',0,'华立',0,null,'黑',350,'2026.5.20','128'],
['FYQVN05AHFXW','7P',0,'广机电',0,null,'黑',350,'2026.5.20','128'],
['C38V9V41JCM1','8P',0,'华立',0,null,'白',900,'2026.5.20','64'],
['FD1WC2RHJCLY','8P',0,'广工商',0,null,'黑',900,'2026.5.20','64'],
['KHG2GNWG6N','air6',0,'广工',0,null,null,null,null,'128'],
['DMPDJ1UONRCC','20pro',0,'广工',0,null,null,null,null,'256'],
['FMWWGJQ721','20pro',0,'湖南涉外',0,null,'灰色',null,null,'128'],
];

async function main() {
  const { data: existing } = await db.collection('devices').get();
  console.log('现有设备数:', existing.length);
  let created = 0, updated = 0, skipped = 0;

  for (const d of raw) {
    const sn = d[0];
    if (!sn) { skipped++; continue; }
    const deviceData = {
      serial_number: sn,
      model: d[1],
      school: d[3] || '',
      version: d[5] || '',
      color: d[6] || '',
      purchase_price: d[7] || 0,
      purchase_date: d[8] || '',
      memory: d[9] || '',
      updated_at: new Date()
    };

    const match = existing.find(e => e.serial_number === sn);
    if (match) {
      await db.collection('devices').doc(match._id).update(deviceData);
      updated++;
    } else {
      deviceData.created_at = new Date();
      await db.collection('devices').add(deviceData);
      created++;
    }
  }

  const { total } = await db.collection('devices').count();
  console.log('新建:', created, '更新:', updated, '跳过(无序列号):', skipped, '总计:', total);
}
main().catch(e => console.error(e));

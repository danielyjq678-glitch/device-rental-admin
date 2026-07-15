// 更新所有商品的描述和标签
require('dotenv').config();
const cb = require('@cloudbase/node-sdk');
const t = cb.init({env:process.env.CLOUD_ENV,secretId:process.env.CLOUD_SECRET_ID,secretKey:process.env.CLOUD_SECRET_KEY});
const db = t.database();

const updates = {
  // ===== 手机 =====
  "34d5e8e86a27d55a00c5db127dc73601": { desc:"经典耐用机型，A10芯片稳如老狗，iOS流畅不卡顿，学生党性价比首选", tags:"经典耐用" },
  "cee2ad326a27d55a0297c07a20591a6a": { desc:"全面屏入门首选，A12仿生芯片，游戏影音轻松驾驭，日常够用不卡顿", tags:"全面屏,A12芯片" },
  "34d5e8e86a27d55a00c5db16308521c9": { desc:"6.5寸OLED大屏旗舰，震撼影音体验，3D Touch加持，握持手感一流", tags:"大屏旗舰,OLED" },
  "cee2ad326a27d55a0297c07d4db3adb8": { desc:"5G时代经典旗舰，A14强芯性能拉满，直角边框设计回归，影像依旧能打", tags:"5G旗舰,A14" },
  "11d826726a27d55a005850252e949d88": { desc:"灵动岛登岛首选！A16芯片+Type-C接口，4800万主摄，告别Lightning时代", tags:"灵动岛,Type-C" },
  "cee2ad326a27d55a0297c09135008858": { desc:"大屏续航怪兽！灵动岛+大电池，追剧刷视频一整天不断电，学生党福音", tags:"续航王者,大屏追剧" },
  "cee2ad326a27d55a0297c09210463ebc": { desc:"年度机皇！5倍光学变焦，钛金属机身，专业视频创作者的不二之选", tags:"影像机皇,5倍光变" },
  "cee2ad326a27d55a0297c094154eba32": { desc:"全新A18 Pro芯片加持，相机控制键一键出片，最强iPhone等你来体验", tags:"最新旗舰,A18Pro" },
  "11d826726a27d55a0058502a57389048": { desc:"蔡司1英寸大底主摄，演唱会追星神器！百米外舞台也能拍出高清直拍", tags:"蔡司影像,演唱会神器" },
  "11d826726a27d55a0058502b529d8a7e": { desc:"演唱会全能套装！手机+增距镜+三脚架全套，到手即拍，追星不将就", tags:"全能套装,追星顶配" },
  "bf757c4c6a27d55a0262b56e05816875": { desc:"专业增距镜套装加持，远景特写不在话下，运动赛事舞台追星必备利器", tags:"增距套装,远景特写" },
  "11d826726a27d55a0058502d33c6f54c": { desc:"蓝厂最新影像旗舰，蔡司联名调色，人像模式一绝，随手拍出杂志大片", tags:"人像大师,蔡司调色" },
  "bf757c4c6a27d55a0262b5704e805943": { desc:"X300p全能套装！旗舰手机+全套配件，专业创作零短板，影像发烧友终极选择", tags:"全能旗舰,影像顶配" },
  "34d5e8e86a27d55b00c5db2e27077bb1": { desc:"远摄增距套装加持，追星拍舞台、看比赛拍特写，距离不再是阻碍", tags:"追星必备,远摄增距" },
  "34d5e8e86a27d55b00c5db2f7fa8a7fc": { desc:"安卓机皇！S Pen书写体验+10倍光学变焦，商务办公与影像创作两不误", tags:"安卓机皇,S Pen" },
  // ===== 云台相机 =====
  "cee2ad326a27d55b0297c09903f2a698": { desc:"口袋里的电影机！1英寸传感器，4K超清画质，Vlog博主人手一台的神器", tags:"Vlog神器,1英寸底" },
  "bf757c4c6a27d55b0262b5722cc2d92b": { desc:"运动相机天花板！超强防抖+裸机防水，滑雪冲浪骑行记录，怎么拍都稳", tags:"运动防抖,裸机防水" },
  // ===== CCD =====
  "bf757c4c6a27d55b0262b5733d82e97a": { desc:"复古CCD质感直出，原片自带氛围感，小红书同款，随手一拍就是胶片大片", tags:"复古质感,原片直出" },
  // ===== 拍立得 =====
  "cee2ad326a27d55b0297c09d5efcb6a8": { desc:"即拍即得的快乐！聚会轰趴必备氛围担当，抓住每一个值得纪念的瞬间", tags:"聚会必备,即拍即得" },
  "11d826726a27d55a0058502f41a27211": { desc:"方形构图更有范儿！自带高级感的画面比例，文艺青年拍照标配", tags:"文艺方画,高级质感" },
  "34d5e8e86a27d55b00c5db35269c6925": { desc:"入门首选！简单好上手，性价比拉满，记录校园生活的第一台拍立得", tags:"入门首选,简单好玩" },
  // ===== 平板 =====
  "cee2ad326a27d55b0297c0a206c1dbdf": { desc:"M2芯片+ProMotion高刷屏，搭配妙控键盘秒变笔记本，创意工作者的效率神器", tags:"M2芯片,专业创作" },
  "cee2ad326a27d55b0297c0a338fa8d32": { desc:"大屏分屏学习利器！考研考公刷网课、做笔记两不误，无纸化学习好帮手", tags:"学习利器,分屏笔记" },
  "cee2ad326a27d55b0297c0a969d7e219": { desc:"鸿蒙生态+护眼柔光屏，书写如纸般细腻，华为生态无纸化学习办公首选", tags:"护眼柔光,鸿蒙生态" },
};

async function main() {
  let count = 0;
  for (const [id, data] of Object.entries(updates)) {
    await db.collection('products').doc(id).update({
      description: data.desc,
      tags: data.tags,
      updated_at: new Date()
    });
    count++;
    console.log(`✅ ${id.slice(-6)}: ${data.tags}`);
  }
  console.log(`\n📊 已更新 ${count} 个商品`);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });

// 临时脚本：重置调试账号抽奖次数
// 用法：node reset-lottery.js
require('dotenv').config();
var cloudbase = require('@cloudbase/node-sdk');

var CLOUD_ENV = process.env.CLOUD_ENV || 'cloud1-d0gtbh90x8d74a386';
var CLOUD_SECRET_ID = process.env.CLOUD_SECRET_ID || '';
var CLOUD_SECRET_KEY = process.env.CLOUD_SECRET_KEY || '';

if (!CLOUD_SECRET_ID) {
  console.error('❌ 未设置 CLOUD_SECRET_ID 环境变量');
  process.exit(1);
}

var tcb = cloudbase.init({
  env: CLOUD_ENV,
  secretId: CLOUD_SECRET_ID,
  secretKey: CLOUD_SECRET_KEY
});
var db = tcb.database();

var OPENID = 'oNYxn3UsnT4c1Cb8TfCHPUxNYT48';
var ACTIVITY_ID = 'b917d0ff6a462594012004505a46ffe3';

async function main() {
  try {
    var { data: records } = await db.collection('lottery_records')
      .where({ openid: OPENID, activityId: ACTIVITY_ID }).get();

    if (!records || records.length === 0) {
      console.log('✅ 没有找到抽奖记录，无需重置');
      process.exit(0);
    }

    console.log('找到 ' + records.length + ' 条抽奖记录：');
    records.forEach(function (r) {
      console.log('  - ' + r._id + ' | ' + (r.prizeName || '') + ' | ' + r.userPhone);
    });

    for (var i = 0; i < records.length; i++) {
      await db.collection('lottery_records').doc(records[i]._id).remove();
      console.log('  已删除: ' + records[i]._id);
    }

    console.log('✅ 抽奖次数已重置！刷新小程序即可重新抽奖。');
  } catch (e) {
    console.error('❌ 删除失败:', e.message);
  }
  process.exit(0);
}

main();

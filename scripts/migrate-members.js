// 批量脚本：将所有已绑定手机号的存量用户升级为会员
// 用法：node scripts/migrate-members.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cloudbase = require('@cloudbase/node-sdk');
var tcb = cloudbase.init({
  env: process.env.CLOUD_ENV,
  secretId: process.env.CLOUD_SECRET_ID,
  secretKey: process.env.CLOUD_SECRET_KEY
});
var db = tcb.database();

var LEVELS = [
  { name: '普通会员', discount: '95折', exp: 0 },
  { name: '白银会员', discount: '9折',  exp: 300 },
  { name: '黄金会员', discount: '8折',  exp: 800 },
  { name: '铂金会员', discount: '7折',  exp: 2000 },
  { name: '钻石会员', discount: '5折',  exp: 5000 }
];

function calcLevel(exp) {
  var level = LEVELS[0];
  for (var i = LEVELS.length - 1; i >= 0; i--) {
    if (exp >= LEVELS[i].exp) { level = LEVELS[i]; break; }
  }
  return level;
}

async function main() {
  // 查询所有已绑定手机号但尚未有 member_level 的用户
  var { data: users } = await db.collection('users')
    .where({ phone: db.command.neq(''), member_level: db.command.exists(false) })
    .limit(1000).get();

  users = Array.isArray(users) ? users : [];
  console.log('待迁移用户数:', users.length);

  var updated = 0;
  for (var u of users) {
    var exp = u.exp || 0;
    var points = u.points || 0;
    var level = calcLevel(exp);
    try {
      await db.collection('users').doc(u._id).update({
        member_level: level.name,
        member_discount: level.discount,
        member_exp: exp,
        member_points: points,
        updated_at: new Date()
      });
      updated++;
    } catch (e) {
      console.error('更新失败:', u._id, e.message);
    }
  }

  console.log('迁移完成:', updated + '/' + users.length + ' 用户已设为会员');
}

main().catch(function (e) { console.error(e); });

/* 语法检查脚本：对 electron/ 与 src/ 下所有 JS 执行 node --check */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dirs = ['electron', 'src'];
let failed = false;

function walk(d) {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      walk(p);
    } else if (name.endsWith('.js')) {
      try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        console.log('ok   ' + p);
      } catch (e) {
        failed = true;
        console.error('FAIL ' + p + '\n' + (e.stderr ? e.stderr.toString() : ''));
      }
    }
  }
}

dirs.forEach(walk);
process.exit(failed ? 1 : 0);

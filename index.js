const inquirer = (require('inquirer') && require('inquirer').default) ? require('inquirer').default : require('inquirer')
async function mainMenu() {
  while (true) {
    const choice = await inquirer.prompt([{ type: 'list', name: 'sel', message: 'What do you want to watch today ?', choices: ['Anime', 'TV / Movies', 'Exit'] }])
    if (choice.sel === 'Exit') return process.exit(0)
    if (choice.sel === 'Anime') {
      const anime = require('./src/anime')
      try { await anime.ensureHistoryFile() } catch (e) {}
      if (anime && typeof anime.main === 'function') await anime.main()
      continue
    }
    const movieweb = require('./src/index')
    if (movieweb && typeof movieweb.main === 'function') await movieweb.main()
  }
}

if (require.main === module) {
  mainMenu().catch(e => { console.error(e); process.exit(1) })
}

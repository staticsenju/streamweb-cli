const core = require('./core')

async function main() {
  const args = process.argv.slice(2)
  const _inq = require('inquirer')
  const inquirer = _inq && _inq.default ? _inq.default : _inq

  while (true) {
  const choice = await inquirer.prompt([{ type: 'list', name: 'act', message: 'Choose an action', choices: ['Search & Play', 'Recently Watched', 'Export History', 'Clear History', 'Settings', 'Return to main menu', 'Exit'] }])
    const act = choice.act
    try {
      if (act === 'Search & Play') {
        let query = args.join(' ')
        if (!query) {
          const resp = await inquirer.prompt([{ name: 'q', message: 'Search:' }])
          query = resp.q || ''
        }
        if (!query) continue
        await core.getId(query)
        await core.poison()
        const { choice: action } = await inquirer.prompt([{ type: 'list', name: 'choice', message: 'Select an option:', choices: ['Play', 'Download (can be slow at times)'] }])
        if (action === 'Play') await core.provideData()
        else await core.dlData(undefined, query)
      } else if (act === 'Recently Watched') {
      } else if (act === 'Recently Watched') {
        await core.viewRecentlyWatched()
      } else if (act === 'Export History') {
  const { out } = await inquirer.prompt([{ name: 'out', message: 'Export path (blank for ./streamweb_history.json):' }])
  const outPath = out && out.trim() ? out.trim() : './streamweb_history.json'
        await core.exportHistory(outPath)
        console.log('Exported to', outPath)
      } else if (act === 'Clear History') {
        const { confirm } = await inquirer.prompt([{ name: 'confirm', message: 'Are you sure? (y/N):' }])
        if (confirm && ['y','yes'].includes(confirm.toLowerCase())) {
          await core.clearHistory()
          console.log('History cleared')
        } else console.log('Aborted')
      } else if (act === 'Settings') {
        await core.showSettingsMenu()
      } else if (act === 'Return to main menu') {
        return
      } else if (act === 'Exit') {
        process.exit(0)
      }
    } catch (e) {
      console.error('Error:', e.message || e)
    }
  }
}

module.exports = { main }

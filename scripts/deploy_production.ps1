param(
    [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root

try {
    $productionFiles = @(
        'public/index.html',
        'public/rise.html',
        'public/report.html',
        'public/sample2.html',
        'public/leaders2.html',
        'public/screening.html',
        'public/stock.html',
        'public/flowmap.html',
        'public/bubbles2.html',
        'public/treemap.html',
        'public/css/home.css',
        'public/css/app-shell.css',
        'public/js/home.js',
        'public/js/app-shell.js',
        'public/sw.js',
        'vercel.json'
    )

    if (-not $SkipValidation) {
        Get-Content -Raw -Encoding UTF8 'public/js/home.js' | node --check
        if ($LASTEXITCODE -ne 0) { throw 'home.js syntax check failed' }
        Get-Content -Raw -Encoding UTF8 'public/js/app-shell.js' | node --check
        if ($LASTEXITCODE -ne 0) { throw 'app-shell.js syntax check failed' }
        Get-Content -Raw -Encoding UTF8 'public/sw.js' | node --check
        if ($LASTEXITCODE -ne 0) { throw 'sw.js syntax check failed' }
        Get-Content -Raw -Encoding UTF8 'vercel.json' | ConvertFrom-Json | Out-Null
        git diff --check
        if ($LASTEXITCODE -ne 0) { throw 'git diff check failed' }
    }

    git add -- $productionFiles
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stage production files' }

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $deployLines = & npx.cmd vercel --prod --yes --force 2>&1
    $deployExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    $deployOutput = $deployLines -join "`n"
    Write-Output $deployOutput
    if ($deployExitCode -ne 0) { throw 'Vercel production deployment failed' }

    $matches = [regex]::Matches(
        $deployOutput,
        'https://whyrise-[a-z0-9]+-stockgame4343-blips-projects\.vercel\.app'
    )
    if (-not $matches.Count) { throw 'Could not determine the Vercel deployment URL' }
    $deploymentUrl = $matches[$matches.Count - 1].Value
    $deploymentHost = ([Uri]$deploymentUrl).Host

    $ErrorActionPreference = 'Continue'
    & npx.cmd vercel alias set $deploymentHost orgo.kr
    $orgoAliasExitCode = $LASTEXITCODE
    & npx.cmd vercel alias set $deploymentHost www.orgo.kr
    $wwwAliasExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    if ($orgoAliasExitCode -ne 0) { throw 'Unable to assign orgo.kr alias' }
    if ($wwwAliasExitCode -ne 0) { throw 'Unable to assign www.orgo.kr alias' }

    $localIndex = Get-Content -Raw -Encoding UTF8 'public/index.html'
    $homeCssRef = [regex]::Match($localIndex, '/css/home\.css\?v=[^"]+').Value
    $homeJsRef = [regex]::Match($localIndex, '/js/home\.js\?v=[^"]+').Value
    $shellJsRef = [regex]::Match($localIndex, '/js/app-shell\.js\?v=[^"]+').Value
    $cacheBuster = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $liveIndex = (curl.exe -sL "https://orgo.kr/?deploy_check=$cacheBuster") -join "`n"

    foreach ($assetRef in @($homeCssRef, $homeJsRef, $shellJsRef)) {
        if (-not $assetRef -or $liveIndex -notmatch [regex]::Escape($assetRef)) {
            throw "Live verification failed for $assetRef"
        }
    }

    Write-Output "ORGO production verified: $deploymentUrl"
}
finally {
    Pop-Location
}

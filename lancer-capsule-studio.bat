@echo off
rem Lance (ou relance) Capsule Studio et ouvre le navigateur.
rem Un serveur Capsule Studio deja ouvert est arrete puis relance : le code est toujours a jour.
rem Fermer cette fenetre arrete le serveur.
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Reglages facultatifs lus dans .env : PORT (8746 par defaut), APP_LABEL (etiquette de la fenetre),
rem BROWSER_HOST (127.0.0.1 par defaut ; "localhost" pour separer la session d'une seconde copie)
set "PORT=8746"
set "APP_LABEL="
set "BROWSER_HOST=127.0.0.1"
if exist ".env" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" /c:"APP_LABEL=" /c:"BROWSER_HOST=" ".env"') do if not "%%b"=="" set "%%a=%%b"
)
if defined APP_LABEL (title Capsule Studio - !APP_LABEL!) else (title Capsule Studio)
set "URL=http://%BROWSER_HOST%:%PORT%"

rem Node.js : celui livre dans le dossier runtime (version portable), sinon celui installe sur le PC
set "NODE=node"
if exist "%~dp0runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js est introuvable.
    echo Telechargez la version portable de Capsule Studio ^(avec Node inclus^) ou installez Node 22 ou plus recent : https://nodejs.org
    pause
    exit /b 1
  )
)

rem Un serveur ecoute deja sur le port ? On verifie que c'est bien Capsule Studio avant de l'arreter
set "OLDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%PORT% .*LISTENING"') do set "OLDPID=%%p"
if defined OLDPID (
  set "ISOURS="
  for /f "usebackq delims=" %%r in (`powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=!OLDPID!'; if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server\.js') { $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); if ($parent -and $parent.CommandLine -match 'lancer-capsule-studio') { 'parent:' + $parent.ProcessId } else { 'node' } }"`) do set "ISOURS=%%r"
  if not defined ISOURS (
    echo Le port %PORT% est occupe par un autre programme ^(processus !OLDPID!^). Rien n'a ete arrete.
    echo Indiquez un autre port dans un fichier .env ^(ligne PORT=8750 par exemple^), puis relancez.
    pause
    exit /b 1
  )
  echo Ancienne version de Capsule Studio trouvee : arret avant redemarrage...
  if "!ISOURS:~0,7!"=="parent:" (
    rem Ferme l'ancienne fenetre et son serveur
    taskkill /PID !ISOURS:~7! /T /F >nul 2>nul
  ) else (
    taskkill /PID !OLDPID! /F >nul 2>nul
  )
  ping -n 2 127.0.0.1 >nul
)

rem Ouverture du navigateur deux secondes apres le demarrage du serveur
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" "%URL%""
"%NODE%" server.js
echo.
echo Capsule Studio est arrete.
pause

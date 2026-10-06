@echo off
setlocal

title Karaoke - Inicializador

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "SEPARATOR=%ROOT%separator-service"
set "PYTHON=%SEPARATOR%\.venv-rocm\Scripts\python.exe"
set "MVN=C:\Program Files\JetBrains\IntelliJ IDEA Community Edition 2025.1.2\plugins\maven\lib\maven3\bin\mvn.cmd"

echo ==========================================
echo        KARAOKE - INICIALIZADOR
echo ==========================================
echo.

if not exist "%PYTHON%" (
    echo ERRO: Ambiente .venv-rocm nao encontrado.
    echo.
    echo Esperado:
    echo %PYTHON%
    echo.
    pause
    exit /b 1
)

if not exist "%MVN%" (
    echo ERRO: Maven do IntelliJ nao encontrado.
    echo.
    echo Esperado:
    echo %MVN%
    echo.
    pause
    exit /b 1
)

echo Ambiente ROCm encontrado.
echo Maven encontrado.
echo.

echo Iniciando Separator Service...
echo Porta: 8001
echo GPU: AMD Radeon RX 6600
echo.

start "Karaoke - Separator ROCm" cmd /k "cd /d "%SEPARATOR%" && "%PYTHON%" -m uvicorn main:app --host 0.0.0.0 --port 8001"

echo Aguardando inicializacao do Separator...
timeout /t 3 /nobreak >nul

echo.
echo Iniciando Spring Boot...
echo Porta: 8080
echo.

start "Karaoke - Spring Boot" cmd /k "cd /d "%BACKEND%" && call "%MVN%" spring-boot:run"

echo.
echo ==========================================
echo       KARAOKE INICIADO
echo ==========================================
echo.
echo Web:       http://localhost:8080
echo Separator: http://localhost:8001
echo.
echo GPU: AMD Radeon RX 6600
echo ROCm: PyTorch
echo.

pause
@echo off
echo ========================================
echo Face-API.js Setup Script
echo ========================================
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing base dependencies first...
    call npm install
)

echo.
echo Step 1: Installing face-api.js dependencies...
echo ========================================
call npm install @vladmandic/face-api canvas

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install dependencies!
    echo Try running: npm install @vladmandic/face-api canvas
    pause
    exit /b 1
)

echo.
echo Step 2: Creating models directory...
echo ========================================
if not exist "models" mkdir models

echo.
echo Step 3: Copying models from Smart_Branch...
echo ========================================

REM Copy model files
if exist "D:\Smart_Branch\public\models" (
    echo Copying from D:\Smart_Branch\public\models...
    copy /Y "D:\Smart_Branch\public\models\ssd_mobilenetv1_model-shard1" "models\"
    copy /Y "D:\Smart_Branch\public\models\ssd_mobilenetv1_model-shard2" "models\"
    copy /Y "D:\Smart_Branch\public\models\ssd_mobilenetv1_model-weights_manifest.json" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_landmark_68_model-shard1" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_landmark_68_model-weights_manifest.json" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_recognition_model-shard1" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_recognition_model-shard2" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_recognition_model-weights_manifest.json" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_expression_model-shard1" "models\"
    copy /Y "D:\Smart_Branch\public\models\face_expression_model-weights_manifest.json" "models\"
    echo Models copied successfully!
) else (
    echo WARNING: Source models not found at D:\Smart_Branch\public\models
    echo Please manually copy the models to the "models" folder.
)

echo.
echo ========================================
echo Setup complete!
echo ========================================
echo.
echo Models directory: %cd%\models
echo.
echo To test, start the server with: npm run dev
echo Then check: http://localhost:5000/api/face/status
echo.
pause

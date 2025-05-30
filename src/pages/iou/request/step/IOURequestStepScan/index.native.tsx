import {useFocusEffect, useIsFocused} from '@react-navigation/core';
import {Str} from 'expensify-common';
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Alert, AppState, Image, InteractionManager, View} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import {useOnyx} from 'react-native-onyx';
import {RESULTS} from 'react-native-permissions';
import Animated, {runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming} from 'react-native-reanimated';
import type {Camera, PhotoFile, Point} from 'react-native-vision-camera';
import {useCameraDevice} from 'react-native-vision-camera';
import type {TupleToUnion} from 'type-fest';
import TestReceipt from '@assets/images/fake-receipt.png';
import Hand from '@assets/images/hand.svg';
import Shutter from '@assets/images/shutter.svg';
import type {FileObject} from '@components/AttachmentModal';
import AttachmentPicker from '@components/AttachmentPicker';
import Button from '@components/Button';
import FullScreenLoadingIndicator from '@components/FullscreenLoadingIndicator';
import Icon from '@components/Icon';
import * as Expensicons from '@components/Icon/Expensicons';
import ImageSVG from '@components/ImageSVG';
import LocationPermissionModal from '@components/LocationPermissionModal';
import PDFThumbnail from '@components/PDFThumbnail';
import PressableWithFeedback from '@components/Pressable/PressableWithFeedback';
import {useProductTrainingContext} from '@components/ProductTrainingContext';
import Text from '@components/Text';
import EducationalTooltip from '@components/Tooltip/EducationalTooltip';
import withCurrentUserPersonalDetails from '@components/withCurrentUserPersonalDetails';
import useLocalize from '@hooks/useLocalize';
import usePolicy from '@hooks/usePolicy';
import useTheme from '@hooks/useTheme';
import useThemeStyles from '@hooks/useThemeStyles';
import {dismissProductTraining} from '@libs/actions/Welcome';
import {readFileAsync, resizeImageIfNeeded, showCameraPermissionsAlert, splitExtensionFromFileName} from '@libs/fileDownload/FileUtils';
import getPhotoSource from '@libs/fileDownload/getPhotoSource';
import getCurrentPosition from '@libs/getCurrentPosition';
import getPlatform from '@libs/getPlatform';
import getReceiptsUploadFolderPath from '@libs/getReceiptsUploadFolderPath';
import {shouldStartLocationPermissionFlow} from '@libs/IOUUtils';
import Log from '@libs/Log';
import Navigation from '@libs/Navigation/Navigation';
import {getIsUserSubmittedExpenseOrScannedReceipt, getManagerMcTestParticipant, getParticipantsOption, getReportOption} from '@libs/OptionsListUtils';
import Permissions from '@libs/Permissions';
import {isPaidGroupPolicy} from '@libs/PolicyUtils';
import {getPolicyExpenseChat, isArchivedReport, isPolicyExpenseChat} from '@libs/ReportUtils';
import playSound, {SOUNDS} from '@libs/Sound';
import {shouldRestrictUserBillableActions} from '@libs/SubscriptionUtils';
import {getDefaultTaxCode} from '@libs/TransactionUtils';
import StepScreenWrapper from '@pages/iou/request/step/StepScreenWrapper';
import withFullTransactionOrNotFound from '@pages/iou/request/step/withFullTransactionOrNotFound';
import withWritableReportOrNotFound from '@pages/iou/request/step/withWritableReportOrNotFound';
import variables from '@styles/variables';
import {
    getMoneyRequestParticipantsFromReport,
    replaceReceipt,
    requestMoney,
    setMoneyRequestParticipants,
    setMoneyRequestParticipantsFromReport,
    setMoneyRequestReceipt,
    startSplitBill,
    trackExpense,
    updateLastLocationPermissionPrompt,
} from '@userActions/IOU';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import type {Participant} from '@src/types/onyx/IOU';
import type {Receipt} from '@src/types/onyx/Transaction';
import CameraPermission from './CameraPermission';
import NavigationAwareCamera from './NavigationAwareCamera/Camera';
import type IOURequestStepScanProps from './types';

function IOURequestStepScan({
    report,
    route: {
        params: {action, iouType, reportID, transactionID, backTo},
    },
    transaction,
    currentUserPersonalDetails,
}: IOURequestStepScanProps) {
    const theme = useTheme();
    const styles = useThemeStyles();
    const device = useCameraDevice('back', {
        physicalDevices: ['wide-angle-camera', 'ultra-wide-angle-camera'],
    });

    const [elementTop, setElementTop] = useState(0);
    const isEditing = action === CONST.IOU.ACTION.EDIT;
    const hasFlash = !!device?.hasFlash;
    const camera = useRef<Camera>(null);
    const [flash, setFlash] = useState(false);
    const [startLocationPermissionFlow, setStartLocationPermissionFlow] = useState(false);
    const [fileResize, setFileResize] = useState<null | FileObject>(null);
    const [fileSource, setFileSource] = useState('');
    const [reportNameValuePairs] = useOnyx(`${ONYXKEYS.COLLECTION.REPORT_NAME_VALUE_PAIRS}${report?.reportID}`);
    const policy = usePolicy(report?.policyID);
    const [personalDetails] = useOnyx(ONYXKEYS.PERSONAL_DETAILS_LIST);
    const [skipConfirmation] = useOnyx(`${ONYXKEYS.COLLECTION.SKIP_CONFIRMATION}${transactionID}`);
    const [activePolicyID] = useOnyx(ONYXKEYS.NVP_ACTIVE_POLICY_ID);
    const [activePolicy] = useOnyx(`${ONYXKEYS.COLLECTION.POLICY}${activePolicyID}`);
    const [betas] = useOnyx(ONYXKEYS.BETAS);
    const platform = getPlatform(true);
    const [mutedPlatforms = {}] = useOnyx(ONYXKEYS.NVP_MUTED_PLATFORMS);
    const isPlatformMuted = mutedPlatforms[platform];
    const [cameraPermissionStatus, setCameraPermissionStatus] = useState<string | null>(null);
    const [didCapturePhoto, setDidCapturePhoto] = useState(false);
    const [isLoadingReceipt, setIsLoadingReceipt] = useState(false);
    const isTabActive = useIsFocused();

    const [pdfFile, setPdfFile] = useState<null | FileObject>(null);

    const defaultTaxCode = getDefaultTaxCode(policy, transaction);
    const transactionTaxCode = (transaction?.taxCode ? transaction?.taxCode : defaultTaxCode) ?? '';
    const transactionTaxAmount = transaction?.taxAmount ?? 0;

    // For quick button actions, we'll skip the confirmation page unless the report is archived or this is a workspace
    // request and the workspace requires a category or a tag
    const shouldSkipConfirmation: boolean = useMemo(() => {
        if (!skipConfirmation || !report?.reportID) {
            return false;
        }

        return !isArchivedReport(reportNameValuePairs) && !(isPolicyExpenseChat(report) && ((policy?.requiresCategory ?? false) || (policy?.requiresTag ?? false)));
    }, [report, skipConfirmation, policy, reportNameValuePairs]);

    const {translate} = useLocalize();

    const askForPermissions = () => {
        // There's no way we can check for the BLOCKED status without requesting the permission first
        // https://github.com/zoontek/react-native-permissions/blob/a836e114ce3a180b2b23916292c79841a267d828/README.md?plain=1#L670
        CameraPermission.requestCameraPermission?.()
            .then((status: string) => {
                setCameraPermissionStatus(status);

                if (status === RESULTS.BLOCKED) {
                    showCameraPermissionsAlert();
                }
            })
            .catch(() => {
                setCameraPermissionStatus(RESULTS.UNAVAILABLE);
            });
    };

    const focusIndicatorOpacity = useSharedValue(0);
    const focusIndicatorScale = useSharedValue(2);
    const focusIndicatorPosition = useSharedValue({x: 0, y: 0});

    const cameraFocusIndicatorAnimatedStyle = useAnimatedStyle(() => ({
        opacity: focusIndicatorOpacity.get(),
        transform: [{translateX: focusIndicatorPosition.get().x}, {translateY: focusIndicatorPosition.get().y}, {scale: focusIndicatorScale.get()}],
    }));

    const focusCamera = (point: Point) => {
        if (!camera.current) {
            return;
        }

        camera.current.focus(point).catch((error: Record<string, unknown>) => {
            if (error.message === '[unknown/unknown] Cancelled by another startFocusAndMetering()') {
                return;
            }
            Log.warn('Error focusing camera', error);
        });
    };

    const tapGesture = Gesture.Tap()
        .enabled(device?.supportsFocus ?? false)
        // eslint-disable-next-line react-compiler/react-compiler
        .onStart((ev: {x: number; y: number}) => {
            const point = {x: ev.x, y: ev.y};

            focusIndicatorOpacity.set(withSequence(withTiming(0.8, {duration: 250}), withDelay(1000, withTiming(0, {duration: 250}))));
            focusIndicatorScale.set(2);
            focusIndicatorScale.set(withSpring(1, {damping: 10, stiffness: 200}));
            focusIndicatorPosition.set(point);

            runOnJS(focusCamera)(point);
        });

    useFocusEffect(
        useCallback(() => {
            setDidCapturePhoto(false);
            const refreshCameraPermissionStatus = () => {
                CameraPermission?.getCameraPermissionStatus?.()
                    .then(setCameraPermissionStatus)
                    .catch(() => setCameraPermissionStatus(RESULTS.UNAVAILABLE));
            };

            InteractionManager.runAfterInteractions(() => {
                // Check initial camera permission status
                refreshCameraPermissionStatus();
            });

            // Refresh permission status when app gain focus
            const subscription = AppState.addEventListener('change', (appState) => {
                if (appState !== 'active') {
                    return;
                }

                refreshCameraPermissionStatus();
            });

            return () => {
                subscription.remove();
            };
        }, []),
    );

    const validateReceipt = (file: FileObject) => {
        const {fileExtension} = splitExtensionFromFileName(file?.name ?? '');
        if (
            !CONST.API_ATTACHMENT_VALIDATIONS.ALLOWED_RECEIPT_EXTENSIONS.includes(
                fileExtension.toLowerCase() as TupleToUnion<typeof CONST.API_ATTACHMENT_VALIDATIONS.ALLOWED_RECEIPT_EXTENSIONS>,
            )
        ) {
            Alert.alert(translate('attachmentPicker.wrongFileType'), translate('attachmentPicker.notAllowedExtension'));
            return false;
        }

        if (!Str.isImage(file.name ?? '') && (file?.size ?? 0) > CONST.API_ATTACHMENT_VALIDATIONS.RECEIPT_MAX_SIZE) {
            Alert.alert(
                translate('attachmentPicker.attachmentTooLarge'),
                translate('attachmentPicker.sizeExceededWithLimit', {maxUploadSizeInMB: CONST.API_ATTACHMENT_VALIDATIONS.RECEIPT_MAX_SIZE / (1024 * 1024)}),
            );
            return false;
        }

        if ((file?.size ?? 0) < CONST.API_ATTACHMENT_VALIDATIONS.MIN_SIZE) {
            Alert.alert(translate('attachmentPicker.attachmentTooSmall'), translate('attachmentPicker.sizeNotMet'));
            return false;
        }
        return true;
    };

    const navigateBack = () => {
        Navigation.goBack();
    };

    const navigateToParticipantPage = useCallback(() => {
        switch (iouType) {
            case CONST.IOU.TYPE.REQUEST:
                Navigation.navigate(ROUTES.MONEY_REQUEST_STEP_PARTICIPANTS.getRoute(CONST.IOU.TYPE.SUBMIT, transactionID, reportID));
                break;
            case CONST.IOU.TYPE.SEND:
                Navigation.navigate(ROUTES.MONEY_REQUEST_STEP_PARTICIPANTS.getRoute(CONST.IOU.TYPE.PAY, transactionID, reportID));
                break;
            default:
                Navigation.navigate(ROUTES.MONEY_REQUEST_STEP_PARTICIPANTS.getRoute(iouType, transactionID, reportID));
        }
    }, [iouType, reportID, transactionID]);

    const navigateToConfirmationPage = useCallback(
        (isTestTransaction = false) => {
            switch (iouType) {
                case CONST.IOU.TYPE.REQUEST:
                    Navigation.navigate(ROUTES.MONEY_REQUEST_STEP_CONFIRMATION.getRoute(CONST.IOU.ACTION.CREATE, CONST.IOU.TYPE.SUBMIT, transactionID, reportID));
                    break;
                case CONST.IOU.TYPE.SEND:
                    Navigation.navigate(ROUTES.MONEY_REQUEST_STEP_CONFIRMATION.getRoute(CONST.IOU.ACTION.CREATE, CONST.IOU.TYPE.PAY, transactionID, reportID));
                    break;
                default:
                    Navigation.navigate(
                        ROUTES.MONEY_REQUEST_STEP_CONFIRMATION.getRoute(CONST.IOU.ACTION.CREATE, isTestTransaction ? CONST.IOU.TYPE.SUBMIT : iouType, transactionID, reportID),
                    );
            }
        },
        [iouType, reportID, transactionID],
    );

    const createTransaction = useCallback(
        (receipt: Receipt, participant: Participant) => {
            if (iouType === CONST.IOU.TYPE.TRACK && report) {
                trackExpense({
                    report,
                    isDraftPolicy: false,
                    participantParams: {
                        payeeEmail: currentUserPersonalDetails.login,
                        payeeAccountID: currentUserPersonalDetails.accountID,
                        participant,
                    },
                    transactionParams: {
                        amount: 0,
                        currency: transaction?.currency ?? 'USD',
                        created: transaction?.created,
                        receipt,
                    },
                });
            } else {
                requestMoney({
                    report,
                    participantParams: {
                        payeeEmail: currentUserPersonalDetails.login,
                        payeeAccountID: currentUserPersonalDetails.accountID,
                        participant,
                    },
                    transactionParams: {
                        amount: 0,
                        attendees: transaction?.comment?.attendees,
                        currency: transaction?.currency ?? 'USD',
                        created: transaction?.created ?? '',
                        merchant: '',
                        receipt,
                    },
                });
            }
        },
        [currentUserPersonalDetails.accountID, currentUserPersonalDetails.login, iouType, report, transaction?.comment?.attendees, transaction?.created, transaction?.currency],
    );

    const navigateToConfirmationStep = useCallback(
        (file: FileObject, source: string, locationPermissionGranted = false, isTestTransaction = false) => {
            if (backTo) {
                Navigation.goBack(backTo);
                return;
            }

            // If a reportID exists in the report object, it's because either:
            // - The user started this flow from using the + button in the composer inside a report.
            // - The user started this flow from using the global create menu by selecting the Track expense option.
            // In this case, the participants can be automatically assigned from the report and the user can skip the participants step and go straight
            // to the confirm step.
            // If the user is started this flow using the Create expense option (combined submit/track flow), they should be redirected to the participants page.
            if (report?.reportID && !isArchivedReport(reportNameValuePairs) && iouType !== CONST.IOU.TYPE.CREATE) {
                const selectedParticipants = getMoneyRequestParticipantsFromReport(report);
                const participants = selectedParticipants.map((participant) => {
                    const participantAccountID = participant?.accountID ?? CONST.DEFAULT_NUMBER_ID;
                    return participantAccountID ? getParticipantsOption(participant, personalDetails) : getReportOption(participant);
                });

                if (shouldSkipConfirmation) {
                    const receipt: Receipt = file;
                    receipt.source = source;
                    receipt.state = CONST.IOU.RECEIPT_STATE.SCANREADY;
                    if (iouType === CONST.IOU.TYPE.SPLIT) {
                        playSound(SOUNDS.DONE);
                        startSplitBill({
                            participants,
                            currentUserLogin: currentUserPersonalDetails?.login ?? '',
                            currentUserAccountID: currentUserPersonalDetails.accountID,
                            comment: '',
                            receipt,
                            existingSplitChatReportID: reportID,
                            billable: false,
                            category: '',
                            tag: '',
                            currency: transaction?.currency ?? 'USD',
                            taxCode: transactionTaxCode,
                            taxAmount: transactionTaxAmount,
                        });
                        return;
                    }
                    const participant = participants.at(0);
                    if (!participant) {
                        return;
                    }
                    if (locationPermissionGranted) {
                        getCurrentPosition(
                            (successData) => {
                                playSound(SOUNDS.DONE);
                                if (iouType === CONST.IOU.TYPE.TRACK && report) {
                                    trackExpense({
                                        report,
                                        isDraftPolicy: false,
                                        participantParams: {
                                            payeeEmail: currentUserPersonalDetails.login,
                                            payeeAccountID: currentUserPersonalDetails.accountID,
                                            participant,
                                        },
                                        policyParams: {
                                            policy,
                                        },
                                        transactionParams: {
                                            amount: 0,
                                            currency: transaction?.currency ?? 'USD',
                                            created: transaction?.created,
                                            receipt,
                                            billable: false,
                                            gpsPoints: {
                                                lat: successData.coords.latitude,
                                                long: successData.coords.longitude,
                                            },
                                        },
                                    });
                                } else {
                                    requestMoney({
                                        report,
                                        participantParams: {
                                            payeeEmail: currentUserPersonalDetails.login,
                                            payeeAccountID: currentUserPersonalDetails.accountID,
                                            participant,
                                        },
                                        policyParams: {
                                            policy,
                                        },
                                        gpsPoints: {
                                            lat: successData.coords.latitude,
                                            long: successData.coords.longitude,
                                        },
                                        transactionParams: {
                                            amount: 0,
                                            attendees: transaction?.comment?.attendees,
                                            currency: transaction?.currency ?? 'USD',
                                            created: transaction?.created ?? '',
                                            merchant: '',
                                            receipt,
                                            billable: false,
                                        },
                                    });
                                }
                            },
                            (errorData) => {
                                Log.info('[IOURequestStepScan] getCurrentPosition failed', false, errorData);
                                // When there is an error, the money can still be requested, it just won't include the GPS coordinates
                                playSound(SOUNDS.DONE);
                                createTransaction(receipt, participant);
                            },
                            {
                                maximumAge: CONST.GPS.MAX_AGE,
                                timeout: CONST.GPS.TIMEOUT,
                            },
                        );
                        return;
                    }
                    playSound(SOUNDS.DONE);
                    createTransaction(receipt, participant);
                    return;
                }
                setMoneyRequestParticipantsFromReport(transactionID, report).then(() => {
                    navigateToConfirmationPage();
                });
                return;
            }

            // If there was no reportID, then that means the user started this flow from the global + menu
            // and an optimistic reportID was generated. In that case, the next step is to select the participants for this expense.
            if (iouType === CONST.IOU.TYPE.CREATE && isPaidGroupPolicy(activePolicy) && activePolicy?.isPolicyExpenseChatEnabled && !shouldRestrictUserBillableActions(activePolicy.id)) {
                const activePolicyExpenseChat = getPolicyExpenseChat(currentUserPersonalDetails.accountID, activePolicy?.id);
                setMoneyRequestParticipantsFromReport(transactionID, activePolicyExpenseChat).then(() => {
                    Navigation.navigate(
                        ROUTES.MONEY_REQUEST_STEP_CONFIRMATION.getRoute(
                            CONST.IOU.ACTION.CREATE,
                            iouType === CONST.IOU.TYPE.CREATE ? CONST.IOU.TYPE.SUBMIT : iouType,
                            transactionID,
                            activePolicyExpenseChat?.reportID,
                        ),
                    );
                });
            } else {
                if (isTestTransaction) {
                    const managerMcTestParticipant = getManagerMcTestParticipant() ?? {};
                    setMoneyRequestParticipants(transactionID, [{...managerMcTestParticipant, selected: true}]);
                    navigateToConfirmationPage(true);
                    return;
                }
                navigateToParticipantPage();
            }
        },
        [
            backTo,
            transaction?.currency,
            transaction?.created,
            transaction?.comment?.attendees,
            iouType,
            report,
            transactionID,
            shouldSkipConfirmation,
            navigateToConfirmationPage,
            activePolicy,
            currentUserPersonalDetails.accountID,
            currentUserPersonalDetails.login,
            navigateToParticipantPage,
            personalDetails,
            createTransaction,
            reportID,
            transactionTaxCode,
            transactionTaxAmount,
            policy,
            reportNameValuePairs,
        ],
    );

    const updateScanAndNavigate = useCallback(
        (file: FileObject, source: string) => {
            navigateBack();
            replaceReceipt({transactionID, file: file as File, source});
        },
        [transactionID],
    );

    /**
     * Sets a test receipt from CONST.TEST_RECEIPT_URL and navigates to the confirmation step
     */
    const setTestReceiptAndNavigate = useCallback(() => {
        try {
            const filename = `${CONST.TEST_RECEIPT.FILENAME}_${Date.now()}.png`;
            const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/${filename}`;
            const source = Image.resolveAssetSource(TestReceipt).uri;

            ReactNativeBlobUtil.config({
                fileCache: true,
                appendExt: 'png',
                path,
            })
                .fetch('GET', source)
                .then(() => {
                    const file: FileObject = {
                        uri: `file://${path}`,
                        name: filename,
                        type: 'image/png',
                        size: 0,
                    };

                    if (!file.uri) {
                        return;
                    }

                    setMoneyRequestReceipt(transactionID, file.uri, filename, !isEditing, file.type);
                    navigateToConfirmationStep(file, file.uri, false, true);
                })
                .catch((error) => {
                    Log.warn('Error downloading test receipt:', {message: error});
                });
        } catch (error) {
            Log.warn('Error in setTestReceiptAndNavigate:', {message: error});
        }
    }, [transactionID, isEditing, navigateToConfirmationStep]);

    const {shouldShowProductTrainingTooltip, renderProductTrainingTooltip} = useProductTrainingContext(
        CONST.PRODUCT_TRAINING_TOOLTIP_NAMES.SCAN_TEST_TOOLTIP,
        !getIsUserSubmittedExpenseOrScannedReceipt() && Permissions.canUseManagerMcTest(betas) && isTabActive,
        {
            onConfirm: setTestReceiptAndNavigate,
            onDismiss: () => {
                dismissProductTraining(CONST.PRODUCT_TRAINING_TOOLTIP_NAMES.SCAN_TEST_TOOLTIP, true);
            },
        },
    );

    /**
     * Sets the Receipt objects and navigates the user to the next page
     */
    const setReceiptAndNavigate = (originalFile: FileObject, isPdfValidated?: boolean) => {
        if (!validateReceipt(originalFile)) {
            return;
        }

        // If we have a pdf file and if it is not validated then set the pdf file for validation and return
        if (Str.isPDF(originalFile.name ?? '') && !isPdfValidated) {
            setPdfFile(originalFile);
            return;
        }

        // With the image size > 24MB, we use manipulateAsync to resize the image.
        // It takes a long time so we should display a loading indicator while the resize image progresses.
        if (Str.isImage(originalFile.name ?? '') && (originalFile?.size ?? 0) > CONST.API_ATTACHMENT_VALIDATIONS.MAX_SIZE) {
            setIsLoadingReceipt(true);
        }
        resizeImageIfNeeded(originalFile).then((file) => {
            setIsLoadingReceipt(false);
            // Store the receipt on the transaction object in Onyx
            // On Android devices, fetching blob for a file with name containing spaces fails to retrieve the type of file.
            // So, let us also save the file type in receipt for later use during blob fetch
            setMoneyRequestReceipt(transactionID, file?.uri ?? '', file.name ?? '', !isEditing, file.type);

            if (isEditing) {
                updateScanAndNavigate(file, file?.uri ?? '');
                return;
            }
            if (shouldSkipConfirmation) {
                setFileResize(file);
                setFileSource(file?.uri ?? '');
                const gpsRequired = transaction?.amount === 0 && iouType !== CONST.IOU.TYPE.SPLIT && file;

                if (gpsRequired) {
                    const beginLocationPermissionFlow = shouldStartLocationPermissionFlow();
                    if (beginLocationPermissionFlow) {
                        setStartLocationPermissionFlow(true);
                        return;
                    }
                }
            }
            navigateToConfirmationStep(file, file?.uri ?? '', false);
        });
    };

    const capturePhoto = useCallback(() => {
        if (!camera.current && (cameraPermissionStatus === RESULTS.DENIED || cameraPermissionStatus === RESULTS.BLOCKED)) {
            askForPermissions();
            return;
        }

        const showCameraAlert = () => {
            Alert.alert(translate('receipt.cameraErrorTitle'), translate('receipt.cameraErrorMessage'));
        };

        if (!camera.current) {
            showCameraAlert();
        }

        if (didCapturePhoto) {
            return;
        }

        setDidCapturePhoto(true);

        const path = getReceiptsUploadFolderPath();

        ReactNativeBlobUtil.fs
            .isDir(path)
            .then((isDir) => {
                if (isDir) {
                    return;
                }

                ReactNativeBlobUtil.fs.mkdir(path).catch((error: string) => {
                    Log.warn('Error creating the directory', error);
                });
            })
            .catch((error: string) => {
                Log.warn('Error checking if the directory exists', error);
            })
            .then(() => {
                camera?.current
                    ?.takePhoto({
                        flash: flash && hasFlash ? 'on' : 'off',
                        enableShutterSound: !isPlatformMuted,
                        path,
                    })
                    .then((photo: PhotoFile) => {
                        // Store the receipt on the transaction object in Onyx
                        const source = getPhotoSource(photo.path);
                        setMoneyRequestReceipt(transactionID, source, photo.path, !isEditing);

                        readFileAsync(
                            source,
                            photo.path,
                            (file) => {
                                if (isEditing) {
                                    updateScanAndNavigate(file, source);
                                    return;
                                }
                                if (shouldSkipConfirmation) {
                                    setFileResize(file);
                                    setFileSource(source);
                                    const gpsRequired = transaction?.amount === 0 && iouType !== CONST.IOU.TYPE.SPLIT && file;
                                    if (gpsRequired) {
                                        const beginLocationPermissionFlow = shouldStartLocationPermissionFlow();
                                        if (beginLocationPermissionFlow) {
                                            setStartLocationPermissionFlow(true);
                                            return;
                                        }
                                    }
                                }
                                navigateToConfirmationStep(file, source, false);
                            },
                            () => {
                                setDidCapturePhoto(false);
                                showCameraAlert();
                                Log.warn('Error reading photo');
                            },
                        );
                    })
                    .catch((error: string) => {
                        setDidCapturePhoto(false);
                        showCameraAlert();
                        Log.warn('Error taking photo', error);
                    });
            });
    }, [
        cameraPermissionStatus,
        didCapturePhoto,
        flash,
        hasFlash,
        isPlatformMuted,
        translate,
        transactionID,
        isEditing,
        shouldSkipConfirmation,
        navigateToConfirmationStep,
        updateScanAndNavigate,
        transaction?.amount,
        iouType,
    ]);

    // Wait for camera permission status to render
    if (cameraPermissionStatus == null) {
        return null;
    }

    return (
        <StepScreenWrapper
            includeSafeAreaPaddingBottom
            headerTitle={translate('common.receipt')}
            onBackButtonPress={navigateBack}
            shouldShowWrapper={!!backTo || isEditing}
            testID={IOURequestStepScan.displayName}
        >
            <View
                style={styles.flex1}
                onLayout={(e) => {
                    setElementTop(e.nativeEvent.layout.height - (variables.tabSelectorButtonHeight + variables.tabSelectorButtonPadding) * 2);
                }}
            >
                {isLoadingReceipt && <FullScreenLoadingIndicator />}
                {!!pdfFile && (
                    <PDFThumbnail
                        style={styles.invisiblePDF}
                        previewSourceURL={pdfFile?.uri ?? ''}
                        onLoadSuccess={() => {
                            setPdfFile(null);
                            if (pdfFile) {
                                setReceiptAndNavigate(pdfFile, true);
                            }
                        }}
                        onPassword={() => {
                            setPdfFile(null);
                            Alert.alert(translate('attachmentPicker.attachmentError'), translate('attachmentPicker.protectedPDFNotSupported'));
                        }}
                        onLoadError={() => {
                            setPdfFile(null);
                            Alert.alert(translate('attachmentPicker.attachmentError'), translate('attachmentPicker.errorWhileSelectingCorruptedAttachment'));
                        }}
                    />
                )}
                <EducationalTooltip
                    shouldRender={shouldShowProductTrainingTooltip}
                    renderTooltipContent={renderProductTrainingTooltip}
                    shouldHideOnNavigate
                    anchorAlignment={{
                        horizontal: CONST.MODAL.ANCHOR_ORIGIN_HORIZONTAL.CENTER,
                        vertical: CONST.MODAL.ANCHOR_ORIGIN_VERTICAL.TOP,
                    }}
                    wrapperStyle={styles.productTrainingTooltipWrapper}
                    shiftVertical={-elementTop}
                >
                    <View style={[styles.flex1]}>
                        {cameraPermissionStatus !== RESULTS.GRANTED && (
                            <View style={[styles.cameraView, styles.permissionView, styles.userSelectNone]}>
                                <ImageSVG
                                    contentFit="contain"
                                    src={Hand}
                                    width={CONST.RECEIPT.HAND_ICON_WIDTH}
                                    height={CONST.RECEIPT.HAND_ICON_HEIGHT}
                                    style={styles.pb5}
                                />

                                <Text style={[styles.textFileUpload]}>{translate('receipt.takePhoto')}</Text>
                                <Text style={[styles.subTextFileUpload]}>{translate('receipt.cameraAccess')}</Text>
                                <Button
                                    success
                                    text={translate('common.continue')}
                                    accessibilityLabel={translate('common.continue')}
                                    style={[styles.p9, styles.pt5]}
                                    onPress={capturePhoto}
                                />
                            </View>
                        )}
                        {cameraPermissionStatus === RESULTS.GRANTED && device == null && (
                            <View style={[styles.cameraView]}>
                                <ActivityIndicator
                                    size={CONST.ACTIVITY_INDICATOR_SIZE.LARGE}
                                    style={[styles.flex1]}
                                    color={theme.textSupporting}
                                />
                            </View>
                        )}
                        {cameraPermissionStatus === RESULTS.GRANTED && device != null && (
                            <View style={[styles.cameraView]}>
                                <GestureDetector gesture={tapGesture}>
                                    <View style={styles.flex1}>
                                        <NavigationAwareCamera
                                            ref={camera}
                                            device={device}
                                            style={styles.flex1}
                                            zoom={device.neutralZoom}
                                            photo
                                            cameraTabIndex={1}
                                        />
                                        <Animated.View style={[styles.cameraFocusIndicator, cameraFocusIndicatorAnimatedStyle]} />
                                    </View>
                                </GestureDetector>
                            </View>
                        )}
                    </View>
                </EducationalTooltip>

                <View style={[styles.flexRow, styles.justifyContentAround, styles.alignItemsCenter, styles.pv3]}>
                    <AttachmentPicker>
                        {({openPicker}) => (
                            <PressableWithFeedback
                                role={CONST.ROLE.BUTTON}
                                accessibilityLabel={translate('receipt.gallery')}
                                style={[styles.alignItemsStart]}
                                onPress={() => {
                                    openPicker({
                                        onPicked: (data) => setReceiptAndNavigate(data.at(0) ?? {}),
                                    });
                                }}
                            >
                                <Icon
                                    height={32}
                                    width={32}
                                    src={Expensicons.Gallery}
                                    fill={theme.textSupporting}
                                />
                            </PressableWithFeedback>
                        )}
                    </AttachmentPicker>
                    <PressableWithFeedback
                        role={CONST.ROLE.BUTTON}
                        accessibilityLabel={translate('receipt.shutter')}
                        style={[styles.alignItemsCenter]}
                        onPress={capturePhoto}
                    >
                        <ImageSVG
                            contentFit="contain"
                            src={Shutter}
                            width={CONST.RECEIPT.SHUTTER_SIZE}
                            height={CONST.RECEIPT.SHUTTER_SIZE}
                        />
                    </PressableWithFeedback>
                    {hasFlash && (
                        <PressableWithFeedback
                            role={CONST.ROLE.BUTTON}
                            accessibilityLabel={translate('receipt.flash')}
                            style={[styles.alignItemsEnd]}
                            disabled={cameraPermissionStatus !== RESULTS.GRANTED}
                            onPress={() => setFlash((prevFlash) => !prevFlash)}
                        >
                            <Icon
                                height={32}
                                width={32}
                                src={flash ? Expensicons.Bolt : Expensicons.boltSlash}
                                fill={theme.textSupporting}
                            />
                        </PressableWithFeedback>
                    )}
                </View>
                {startLocationPermissionFlow && !!fileResize && (
                    <LocationPermissionModal
                        startPermissionFlow={startLocationPermissionFlow}
                        resetPermissionFlow={() => setStartLocationPermissionFlow(false)}
                        onGrant={() => navigateToConfirmationStep(fileResize, fileSource, true)}
                        onDeny={() => {
                            updateLastLocationPermissionPrompt();
                            navigateToConfirmationStep(fileResize, fileSource, false);
                        }}
                    />
                )}
            </View>
        </StepScreenWrapper>
    );
}

IOURequestStepScan.displayName = 'IOURequestStepScan';

const IOURequestStepScanWithOnyx = IOURequestStepScan;

const IOURequestStepScanWithCurrentUserPersonalDetails = withCurrentUserPersonalDetails(IOURequestStepScanWithOnyx);
// eslint-disable-next-line rulesdir/no-negated-variables
const IOURequestStepScanWithWritableReportOrNotFound = withWritableReportOrNotFound(IOURequestStepScanWithCurrentUserPersonalDetails, true);
// eslint-disable-next-line rulesdir/no-negated-variables
const IOURequestStepScanWithFullTransactionOrNotFound = withFullTransactionOrNotFound(IOURequestStepScanWithWritableReportOrNotFound);

export default IOURequestStepScanWithFullTransactionOrNotFound;

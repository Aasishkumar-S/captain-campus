import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../data/models/user_model.dart';
import '../../data/repositories/auth_repository.dart';

// Stream of Firebase User auth state
final authStateProvider = StreamProvider<User?>((ref) {
  final authRepo = ref.watch(authRepositoryProvider);
  return authRepo.authStateChanges;
});

// Profile fetched from Firestore for the currently logged in user
final userProfileProvider = FutureProvider<UserModel?>((ref) async {
  final authState = ref.watch(authStateProvider);
  final user = authState.value;
  if (user == null) return null;

  final authRepo = ref.watch(authRepositoryProvider);
  return await authRepo.getUserProfile(user.uid);
});

// Auth Controller managing sign-in, registration, sign-out actions and async state
final authControllerProvider =
    StateNotifierProvider<AuthController, AsyncValue<void>>((ref) {
  final authRepo = ref.watch(authRepositoryProvider);
  return AuthController(authRepo, ref);
});

class AuthController extends StateNotifier<AsyncValue<void>> {
  final AuthRepository _authRepository;
  final Ref _ref;

  AuthController(this._authRepository, this._ref)
      : super(const AsyncValue.data(null));

  Future<bool> signIn(String email, String password) async {
    state = const AsyncValue.loading();
    try {
      await _authRepository.signInWithEmailPassword(email, password);
      state = const AsyncValue.data(null);
      _ref.invalidate(userProfileProvider);
      return true;
    } catch (e, stack) {
      state = AsyncValue.error(e, stack);
      return false;
    }
  }

  Future<bool> signUp({
    required String email,
    required String password,
    required String name,
    String? studentId,
  }) async {
    state = const AsyncValue.loading();
    try {
      final credential = await _authRepository.signUpWithEmailPassword(email, password);
      final uid = credential.user?.uid;
      if (uid != null) {
        await _authRepository.createUserProfile(
          uid: uid,
          name: name,
          email: email,
          studentId: studentId,
        );
      }
      state = const AsyncValue.data(null);
      _ref.invalidate(userProfileProvider);
      return true;
    } catch (e, stack) {
      state = AsyncValue.error(e, stack);
      return false;
    }
  }

  Future<void> signOut() async {
    state = const AsyncValue.loading();
    try {
      await _authRepository.signOut();
      state = const AsyncValue.data(null);
      _ref.invalidate(userProfileProvider);
    } catch (e, stack) {
      state = AsyncValue.error(e, stack);
    }
  }
}

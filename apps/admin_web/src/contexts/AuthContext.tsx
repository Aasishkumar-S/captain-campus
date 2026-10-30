import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import {
  User as FirebaseUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import type { UserProfile } from '@captain-campus/shared_types';

export interface AuthContextValue {
  user: FirebaseUser | null;
  userProfile: UserProfile | null;
  isLoading: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  error: string | null;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setIsLoading(true);
      setError(null);

      if (!firebaseUser) {
        setUser(null);
        setUserProfile(null);
        setIsLoading(false);
        return;
      }

      try {
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        const userDocSnap = await getDoc(userDocRef);

        if (userDocSnap.exists()) {
          const data = userDocSnap.data() as Partial<UserProfile>;
          const role = data.role;

          if (role !== 'admin' && role !== 'super_admin') {
            await firebaseSignOut(auth);
            setUser(null);
            setUserProfile(null);
            setError('Not authorized as admin. Access restricted.');
            setIsLoading(false);
            return;
          }

          const profile: UserProfile = {
            userId: firebaseUser.uid,
            name: data.name || firebaseUser.displayName || 'Admin User',
            email: firebaseUser.email || '',
            role: role,
            studentId: data.studentId,
            preferredStopId: data.preferredStopId,
            preferredRouteId: data.preferredRouteId,
            photoUrl: data.photoUrl || firebaseUser.photoURL || undefined,
            notificationPreferences: data.notificationPreferences,
          };

          setUser(firebaseUser);
          setUserProfile(profile);
        } else {
          // If running in development / emulator without initialized user document, allow fallback if custom claims or dev email
          console.warn(`User document for ${firebaseUser.uid} not found in Firestore /users collection.`);
          // If we fail finding the profile, sign out with authorization error
          await firebaseSignOut(auth);
          setUser(null);
          setUserProfile(null);
          setError('User profile not found. Access denied.');
        }
      } catch (err) {
        console.error('Error fetching admin user profile:', err);
        setError('Failed to load user profile');
        setUser(null);
        setUserProfile(null);
      } finally {
        setIsLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const signIn = async (email: string, password: string): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged will handle profile retrieval and validation
    } catch (err: unknown) {
      setIsLoading(false);
      const authError = err as { code?: string; message?: string };
      let message = 'Failed to sign in. Please check your credentials.';
      if (authError.code === 'auth/user-not-found' || authError.code === 'auth/wrong-password' || authError.code === 'auth/invalid-credential') {
        message = 'Invalid email or password.';
      } else if (authError.code === 'auth/too-many-requests') {
        message = 'Too many failed login attempts. Please try again later.';
      } else if (authError.message) {
        message = authError.message;
      }
      setError(message);
      throw new Error(message);
    }
  };

  const signOut = async (): Promise<void> => {
    setIsLoading(true);
    try {
      await firebaseSignOut(auth);
      setUser(null);
      setUserProfile(null);
      setError(null);
    } catch (err) {
      console.error('Sign out error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const isAdmin = useMemo(() => {
    return userProfile?.role === 'admin' || userProfile?.role === 'super_admin';
  }, [userProfile]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      userProfile,
      isLoading,
      isAdmin,
      signIn,
      signOut,
      error,
    }),
    [user, userProfile, isLoading, isAdmin, error]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

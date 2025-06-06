import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../generated/prisma';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest } from './course.controller';

interface AddUserRequest {
  email: string;
  name: string;
  password: string;
}

interface AssignCourseRequest {
  userIds: string[];
}

// User Management
export const getTenantUsers = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id: tenantId } = req.params;
    const users = await prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        enrollments: {
          include: {
            course: true
          }
        }
      }
    });
    res.json(users);
  } catch (error) {
    next(error);
  }
};

export const addUserToTenant = async (
  req: Request<{ id: string }, any, AddUserRequest>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id: tenantId } = req.params;
    const { email, name, password } = req.body;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      res.status(400).json({ error: 'User already exists' });
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashedPassword,
        role: UserRole.USER,
        tenantId
      }
    });

    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
};

export const removeUserFromTenant = async (
  req: Request<{ id: string; userId: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id: tenantId, userId } = req.params;

    // Verify user belongs to tenant
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        tenantId
      }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found in tenant' });
      return;
    }

    await prisma.user.delete({
      where: { id: userId }
    });

    res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// Course Management
export const getTenantCourses = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id: tenantId } = req.params;
    const courses = await prisma.tenantCourse.findMany({
      where: { tenantId },
      include: {
        course: true
      }
    });
    res.json(courses);
  } catch (error) {
    next(error);
  }
};

export const assignCourseToUsers = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { courseId, userIds } = req.body;

    if (!courseId || !userIds || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ error: 'courseId and userIds[] are required' });
      return;
    }

    // Get the tenantId from the first user (all users should belong to the same tenant)
    const user = await prisma.user.findUnique({ where: { id: userIds[0] } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const tenantId = user.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: 'User does not belong to a tenant' });
      return;
    }

    // Ensure TenantCourse exists
    let tenantCourse = await prisma.tenantCourse.findFirst({
      where: { tenantId, courseId }
    });
    if (!tenantCourse) {
      tenantCourse = await prisma.tenantCourse.create({
        data: { tenantId, courseId }
      });
    }

    // Create enrollments for each user (skip if already enrolled)
    const enrollments = await Promise.all(
      userIds.map(async (userId: string) => {
        // Check if enrollment already exists
        const existingEnrollment = await prisma.enrollment.findFirst({
          where: { userId, courseId }
        });
        if (existingEnrollment) {
          // Fetch with user and course included for consistency
          return prisma.enrollment.findUnique({
            where: { id: existingEnrollment.id },
            include: { user: true, course: true }
          });
        }

        // Create new enrollment
        return prisma.enrollment.create({
          data: {
            userId,
            courseId,
            progress: 0,
            status: 'IN_PROGRESS'
          },
          include: {
            user: true,
            course: true
          }
        });
      })
    );

    res.status(201).json({
      message: 'Course assigned successfully',
      enrollments
    });
  } catch (error) {
    console.error('Error assigning course:', error);
    res.status(500).json({ error: 'Failed to assign course', details: error instanceof Error ? error.message : error });
  }
};

// Progress Tracking
export const getTenantProgress = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { tenantId } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        users: {
          include: {
            enrollments: {
              include: {
                course: true
              }
            }
          }
        }
      }
    });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    // Calculate statistics
    const stats = {
      totalUsers: tenant.users.length,
      totalEnrollments: 0,
      completedCourses: 0,
      inProgressCourses: 0,
      averageProgress: 0,
      userProgress: tenant.users.map(user => ({
        userId: user.id,
        userName: user.name,
        email: user.email,
        enrollments: user.enrollments.length,
        completedCourses: user.enrollments.filter(e => e.status === 'COMPLETED').length,
        inProgressCourses: user.enrollments.filter(e => e.status === 'IN_PROGRESS').length,
        averageProgress: user.enrollments.reduce((acc, e) => acc + Number(e.progress), 0) / (user.enrollments.length || 1)
      }))
    };

    // Calculate overall statistics
    const allEnrollments = tenant.users.flatMap(u => u.enrollments);
    stats.totalEnrollments = allEnrollments.length;
    stats.completedCourses = allEnrollments.filter(e => e.status === 'COMPLETED').length;
    stats.inProgressCourses = allEnrollments.filter(e => e.status === 'IN_PROGRESS').length;
    stats.averageProgress = allEnrollments.reduce((acc, e) => acc + Number(e.progress), 0) / (allEnrollments.length || 1);

    res.json(stats);
  } catch (error) {
    next(error);
  }
};

export const getTenantCompletionStats = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { tenantId } = req.params;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        courses: {
          include: {
            course: {
              include: {
                enrollments: {
                  where: {
                    user: {
                      tenantId
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const courseStats = tenant.courses.map(tc => {
      const enrollments = tc.course.enrollments;
      const totalEnrollments = enrollments.length;
      const completedEnrollments = enrollments.filter(e => e.status === 'COMPLETED').length;
      const inProgressEnrollments = enrollments.filter(e => e.status === 'IN_PROGRESS').length;
      const averageProgress = enrollments.reduce((acc, e) => acc + Number(e.progress), 0) / (totalEnrollments || 1);

      return {
        courseId: tc.course.id,
        courseTitle: tc.course.title,
        totalEnrollments,
        completedEnrollments,
        inProgressEnrollments,
        completionRate: (completedEnrollments / (totalEnrollments || 1)) * 100,
        averageProgress
      };
    });

    // Overall statistics
    const stats = {
      totalCourses: tenant.courses.length,
      courseStats,
      overallStats: {
        totalEnrollments: courseStats.reduce((acc, c) => acc + c.totalEnrollments, 0),
        totalCompletions: courseStats.reduce((acc, c) => acc + c.completedEnrollments, 0),
        averageCompletionRate: courseStats.reduce((acc, c) => acc + c.completionRate, 0) / (tenant.courses.length || 1),
        averageProgress: courseStats.reduce((acc, c) => acc + c.averageProgress, 0) / (tenant.courses.length || 1)
      }
    };

    res.json(stats);
  } catch (error) {
    next(error);
  }
};

export const getUserProgress = async (
  req: Request<{ userId: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        enrollments: {
          include: {
            course: {
              select: {
                id: true,
                title: true,
                description: true,
                slides: true
              }
            }
          }
        }
      }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const userProgress = {
      userId: user.id,
      userName: user.name,
      email: user.email,
      totalCourses: user.enrollments.length,
      completedCourses: user.enrollments.filter(e => e.status === 'COMPLETED').length,
      inProgressCourses: user.enrollments.filter(e => e.status === 'IN_PROGRESS').length,
      averageProgress: user.enrollments.reduce((acc, e) => acc + Number(e.progress), 0) / (user.enrollments.length || 1),
      courses: user.enrollments.map(enrollment => ({
        courseId: enrollment.course.id,
        courseTitle: enrollment.course.title,
        description: enrollment.course.description,
        status: enrollment.status,
        progress: enrollment.progress,
        createdAt: new Date().toISOString() 
      }))
    };

    res.json(userProgress);
  } catch (error) {
    next(error);
  }
};

export const getUserCourseContent = async (
  req: Request<{ userId: string; courseId: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { userId, courseId } = req.params;

    const enrollment = await prisma.enrollment.findFirst({
      where: {
        userId,
        courseId
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            slides: true
          }
        }
      }
    });

    if (!enrollment) {
      res.status(404).json({ error: 'Course enrollment not found' });
      return;
    }

    const courseContent = {
      courseId: enrollment.course.id,
      courseTitle: enrollment.course.title,
      description: enrollment.course.description,
      progress: enrollment.progress,
      status: enrollment.status,
      slides: enrollment.course.slides,
      lastAccessed: new Date().toISOString() 
    };

    res.json(courseContent);
  } catch (error) {
    next(error);
  }
};

// Enable/Disable Course
export const toggleCourseStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { tenantId, courseId } = req.params;
    const { isEnabled } = req.body;

    // Check if user is authenticated and has admin role
    if (!req.user || req.user.role !== 'ADMIN') {
      res.status(403).json({ error: 'Only tenant admins can toggle course status' });
      return;
    }

    // Validate request body
    if (typeof isEnabled !== 'boolean') {
      res.status(400).json({ error: 'isEnabled must be a boolean value' });
      return;
    }

    // Check if tenant exists
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    // Check if course exists for this tenant
    const tenantCourse = await prisma.tenantCourse.findFirst({
      where: { 
        tenantId, 
        courseId,
        course: {
          id: courseId
        }
      }
    });
    
    if (!tenantCourse) {
      res.status(404).json({ error: 'Course not found for this tenant' });
      return;
    }

    // Update course status
    const updatedCourse = await prisma.tenantCourse.update({
      where: { id: tenantCourse.id },
      data: { isEnabled },
      include: {
        course: true
      }
    });

    res.json({
      message: `Course ${isEnabled ? 'enabled' : 'disabled'} successfully`,
      course: updatedCourse
    });
  } catch (error) {
    console.error('Error toggling course status:', error);
    res.status(500).json({ 
      error: 'Failed to update course status',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Get enabled courses for tenant
export const getEnabledCourses = async (
  req: Request<{ tenantId: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { tenantId } = req.params;

    const courses = await prisma.tenantCourse.findMany({
      where: { 
        tenantId,
        isEnabled: true
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            learningObjectives: true,
            tags: true,
            materialUrl: true,
            enrollments: {
              where: {
                user: {
                  tenantId
                }
              }
            }
          }
        },
        details: {
          select: {
            id: true,
            role: true,
            name: true,
            contact: true
          }
        }
      }
    });

    const formattedCourses = courses.map(tc => ({
      id: tc.id,
      courseId: tc.courseId,
      title: tc.course.title,
      description: tc.course.description,
      learningObjectives: tc.course.learningObjectives,
      tags: tc.course.tags,
      materialUrl: tc.course.materialUrl,
      enrolledUsers: tc.course.enrollments.length,
      skippable: tc.skippable,
      mandatory: tc.mandatory,
      retryType: tc.retryType,
      isEnabled: tc.isEnabled,
      pocs: tc.details
    }));

    res.json(formattedCourses);
  } catch (error) {
    next(error);
  }
};

// Get disabled courses for tenant
export const getDisabledCourses = async (
  req: Request<{ tenantId: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { tenantId } = req.params;

    const courses = await prisma.tenantCourse.findMany({
      where: { 
        tenantId,
        isEnabled: false
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            learningObjectives: true,
            tags: true,
            materialUrl: true,
            enrollments: {
              where: {
                user: {
                  tenantId
                }
              }
            }
          }
        },
        details: {
          select: {
            id: true,
            role: true,
            name: true,
            contact: true
          }
        }
      }
    });

    const formattedCourses = courses.map(tc => ({
      id: tc.id,
      courseId: tc.courseId,
      title: tc.course.title,
      description: tc.course.description,
      learningObjectives: tc.course.learningObjectives,
      tags: tc.course.tags,
      materialUrl: tc.course.materialUrl,
      enrolledUsers: tc.course.enrollments.length,
      skippable: tc.skippable,
      mandatory: tc.mandatory,
      retryType: tc.retryType,
      isEnabled: tc.isEnabled,
      pocs: tc.details
    }));

    res.json(formattedCourses);
  } catch (error) {
    next(error);
  }
};

// Get all courses
export const getAllCourses = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Get user's tenant
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true }
    });

    if (!user?.tenant) {
      res.status(404).json({ error: 'User not associated with any tenant' });
      return;
    }

    // Get enabled courses for the tenant
    const tenantCourses = await prisma.tenantCourse.findMany({
      where: {
        tenantId: user.tenant.id,
        isEnabled: true
      },
      include: {
        course: true
      }
    });

    const courses = tenantCourses.map(tc => tc.course);

    res.json(courses);
  } catch (error) {
    next(error);
  }
};

// Get enabled courses for user with enrollment details
export const getUserEnabledCourses = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { tenantId } = req.query;

    if (!tenantId) {
      res.status(400).json({ error: 'Tenant ID is required' });
      return;
    }

    // Get enabled courses for the tenant with enrollments
    const tenantCourses = await prisma.tenantCourse.findMany({
      where: {
        tenantId: tenantId as string,
        isEnabled: true
      },
      include: {
        course: {
          include: {
            enrollments: {
              where: {
                user: {
                  tenantId: tenantId as string
                }
              }
            }
          }
        }
      }
    });

    const formattedCourses = tenantCourses.map(tc => ({
      id: tc.course.id,
      title: tc.course.title,
      description: tc.course.description,
      createdAt: tc.course.createdAt,
      learningObjectives: tc.course.learningObjectives,
      materialUrl: tc.course.materialUrl,
      slides: tc.course.slides,
      tags: tc.course.tags,
      updatedAt: tc.course.updatedAt,
      videoUrl: tc.course.videoUrl,
      enrollments: tc.course.enrollments.map(e => ({
        id: e.id,
        userId: e.userId,
        courseId: e.courseId,
        progress: e.progress,
        status: e.status,
        lastReminderSent: e.lastReminderSent
      })),
      enrolledUsers: tc.course.enrollments.length,
      skippable: tc.skippable,
      mandatory: tc.mandatory,
      retryType: tc.retryType
    }));

    res.json(formattedCourses);
  } catch (error) {
    next(error);
  }
};

// Update course properties and POC details
export const updateCourseProperties = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { 
      tenantId,
      courseId,
      skippable, 
      mandatory, 
      retryType,
      pocs 
    } = req.body;

    if (!tenantId || !courseId) {
      res.status(400).json({ error: 'tenantId and courseId are required' });
      return;
    }

    const tenantCourse = await prisma.tenantCourse.findFirst({
      where: { 
        tenantId, 
        courseId 
      }
    });

    if (!tenantCourse) {
      res.status(404).json({ error: 'Course not found for this tenant' });
      return;
    }

    await prisma.tenantCourse.update({
      where: { id: tenantCourse.id },
      data: {
        ...(typeof skippable === 'boolean' && { skippable }),
        ...(typeof mandatory === 'boolean' && { mandatory }),
        ...(retryType && { retryType: retryType === 'DIFFERENT' ? 'DIFFERENT' : 'SAME' })
      }
    });

    if (Array.isArray(pocs)) {
      await prisma.tenantCourseDetails.deleteMany({
        where: { tenantCourseId: tenantCourse.id }
      });

      if (pocs.length > 0) {
        await prisma.tenantCourseDetails.createMany({
          data: pocs.map(poc => ({
            tenantCourseId: tenantCourse.id,
            role: poc.role,
            name: poc.name,
            contact: poc.contact
          }))
        });
      }
    }

    const updatedData = await prisma.tenantCourse.findUnique({
      where: { id: tenantCourse.id },
      select: {
        id: true,
        tenantId: true,
        courseId: true,
        skippable: true,
        mandatory: true,
        retryType: true,
        isEnabled: true,
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            materialUrl: true,
            tags: true,
            learningObjectives: true
          }
        },
        details: {
          select: {
            id: true,
            role: true,
            name: true,
            contact: true
          }
        }
      }
    });

    res.json(updatedData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update course properties' });
  }
}; 
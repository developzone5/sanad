using School.Application.Assignments;
using Xunit;

namespace School.Application.Tests;

public class AssignmentServiceTests : DbTestBase
{
    [Fact]
    public async Task Create_saves_the_assignment_for_the_teachers_class()
    {
        var (db, classId, teacherId) = await SeedClassAsync();
        var id = await new AssignmentService(db).CreateAsync(new CreateAssignmentDto(classId, "Essay", null), teacherId, default);
        Assert.Equal("Essay", (await db.Assignments.FindAsync(id))!.Title);
    }

    [Fact]
    public async Task Create_refuses_an_empty_title()
    {
        var (db, classId, teacherId) = await SeedClassAsync();
        await Assert.ThrowsAsync<ValidationException>(() => new AssignmentService(db).CreateAsync(new CreateAssignmentDto(classId, "  ", null), teacherId, default));
    }
}
